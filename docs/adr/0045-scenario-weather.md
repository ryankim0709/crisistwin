# 0045: Scenario weather from free archives and forecasts

Date: 2026-10-24. Status: accepted for the `sim/` module; wiring into Studio and live drills is a
follow-up.

Builds on `0030-scenario-engine.md` (any California fire as a drill, wind
assumptions kept labelled; that file is not on `main` yet, it is on `feat/live-replay-sim`) and
[0004-physics-fire-model](0004-physics-fire-model.md). Detail and numbers:
[scenario-weather](../scenario-weather.md).

## Context

Studio fires run on a single assumed wind (`FireScenario.windSpeedMph`, 40 mph default) or one
optional NWS reading (`app/src/fire/weather.ts`). Scenarios anywhere in California need wind that
varies by hour and a stated origin: observed history for replays, a statistical event for "a bad
north-wind day in November", a forecast for "now". `AGENTS.md` requires every number to be sourced
or an ASSUMPTION, with units and time zones explicit, no paid services, and observed, forecast and
derived data kept distinct.

## Decision

1. **Sources** (all free, no key): the IEM ASOS/AWOS archive (airports), the IEM DCP/HADS archive
   for RAWS fire-weather stations, and NWS `api.weather.gov` gridpoint forecasts. Terms are recorded
   in the doc and in every series' provenance. Not used: WRCC RAWS (interactive form, no published
   programmatic terms), Synoptic/MesoWest (token), IEM's `RAWS` network (empty).
2. **`sim/weather.py`, stdlib only.** `nearest_stations`, `fetch_history`, `scenario_wind(lon, lat,
   start, hours, mode)` with modes `historical_replay`, `climatology_percentile`, `forecast`.
   Network goes through one injectable `http_get`; tests run offline on trimmed real fixtures.
3. **Common series**: hourly, UTC (aware datetimes only), SI units, direction as "from" in degrees
   true, gaps kept as `None`, no interpolation, no height conversion (stated, as in `weather.ts`).
   Observations are binned to the nearest hour, direction by vector mean, gust never synthesised.
4. **Evidence class on every series**: `observed` (station), `forecast` (NWS gridpoint, never
   cached), `derived` (climatology). The climatology event is a real observed episode chosen by
   nearest-rank percentile of episode peaks and relabelled to the scenario start, not a smoothed or
   invented wind.
5. **Station choice is visible.** Candidates and their coverage are returned; RAWS and ASOS compete
   on distance, and coverage below 75% moves to the next station. The Camp day shows why this
   matters: ridge RAWS saw 8-14 m/s north-northeast wind where the valley airports saw light
   northwesterlies.
6. **Disk cache outside the repo** (`$CRISISTWIN_WEATHER_CACHE` or `~/.cache/crisistwin/weather`),
   with URL, byte size and SHA-256 per file; a mismatch refetches. Fixtures in the repo are small
   trimmed responses, labelled as fixtures.
7. **Forecast error as an evidence file.** Archived NWS Fire Weather Planning Forecasts are
   available free from the IEM text archive. `sim/weather_forecast_error.py` compares them with
   observed wind for Camp (2018-11-08) and Tubbs (2017-10-08/09) and writes
   `sim/evidence/weather_forecast_error_2017_2018.json`. The findings seed a "wind shift" inject
   as ASSUMPTION defaults, not as a validated error model.

## Consequences

- The Studio and fire model can replace the assumed wind with a labelled series. They must carry
  the evidence class, station and distance to the UI and stop or visibly fall back on `None`.
  Backend route, unit conversion (m/s to mph, no direction flip) and the clock stepping are
  specified in the doc; `app/src` is untouched by this change.
- Forecast-error figures come from two events, a handful of stations and overlapping products;
  they are an order of magnitude, with our own zone-to-station assignment, and must not be
  presented as a verified forecast skill.
- A first call needs the network and respects IEM's per-IP throttle (HTTP 429 is retried with
  backoff). Cached history and climatology then run offline. RAWS via HADS has gaps by station and
  year; the coverage fallback handles it but a remote point may have no wind station near it.
- RAWS winds are 20 ft and ASOS/gridpoint winds 10 m, neither converted to the open 20 ft wind
  Rothermel wants.
- Climatology is thin (single digits of episodes per month at one station) and uses 2012-2025
  by default; it describes a plausible bad day, not a probability.
