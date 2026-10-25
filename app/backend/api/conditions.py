"""GET /api/conditions and GET /api/conditions/presets: world conditions from a date and place.

`/api/conditions` returns, for ``hours + 1`` hourly samples, the scenario weather of
`sim/weather.py` (same station choice, modes and limits as `GET /api/weather/scenario`) with the
open 20 ft wind, plus per-hour dead and live fuel moisture from `sim/fuel_moisture.py`, in the
fraction shape of `app/src/fire/rothermel.ts` ``FuelMoisture``. Contract, units and examples:
docs/scenario-weather.md ("Fuel moisture from the date's weather").

Query: ``lon``, ``lat`` (WGS84 degrees); ``start`` (ISO 8601 UTC ending in Z; optional for
``forecast``); ``hours`` (1-72, default 24); ``mode`` (``historical_replay`` | ``climatology_percentile``
| ``forecast``); ``percentile`` (50-99.9, climatology only, default 95); ``sector`` (``from,to``
degrees, climatology only, default the offshore 315,90); ``station`` (historical_replay only: an IEM
station id or ``reanalysis``; default the best-ranked station). Site (Rothermel 1983 Exhibit II-2):
``aspect`` (N|E|S|W or degrees, default S), ``slope_pct`` (default 0), ``shading``
(exposed|shaded, default exposed), ``elevation`` (B|L|A relative to the weather station, default L),
``night_inversion`` (0|1, default 0) and ``station_aspect`` (Table F only, default S). Live
moisture: ``region`` (a preset region id) or ``phenology`` (a class id); otherwise the nearest
region within 60 km, else the default class.

Answers are cached in MongoDB (`conditions_cache`) keyed by the normalized query and the model
version; forecast entries expire after ``FORECAST_CACHE_SECONDS``. Errors: 400 bad query, 502 no
data or upstream error, 503 upstream unreachable.
"""

import json
import logging
import sys
from datetime import UTC, datetime, timedelta

from django.core.exceptions import ImproperlyConfigured
from pymongo.errors import PyMongoError
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from .dispatch_area import _error
from .live.twin_service import REPO_ROOT
from .mongodb import get_cache_database
from .scenario_weather import DEFAULT_HOURS, MAX_HOURS, _number, _parse_start, add_20ft_wind, parse_station

logger = logging.getLogger(__name__)

COLLECTION = "conditions_cache"
CACHE_SCHEMA = "conditions/2"  # 2: ranked station choice + reanalysis fallback (sim/weather.py)
FORECAST_CACHE_SECONDS = 3600  # a forecast answer older than this is refetched
SPINUP_HOURS = 48  # observed hours before the window that warm up the 10-h/100-h state
# Assumption: a station farther than this does not represent the query point. sim/weather.py only
# ranks stations within 60 km for historical_replay (beyond that it uses the ERA5 reanalysis), so
# this guards the climatology fallback (nearest long-record ASOS) and points outside the
# catalogued states.
MAX_STATION_DISTANCE_KM = 100.0
_MONGO_ERRORS = (PyMongoError, ValueError, ImproperlyConfigured, AttributeError, TypeError)


class NoStationCoverage(Exception):
    """The nearest station sim/weather.py found is too far from the query point."""


class ConditionsThrottle(AnonRateThrottle):
    scope = "conditions"
    rate = "30/min"


def _sim():
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)
    from sim import conditions_presets, fuel_moisture, weather

    return weather, fuel_moisture, conditions_presets


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- cache


def _cache_get(key: str) -> dict | None:
    try:
        doc = get_cache_database()[COLLECTION].find_one({"_id": key, "schema": CACHE_SCHEMA})
    except _MONGO_ERRORS:
        logger.warning("conditions cache read failed; computing without it")
        return None
    if not doc:
        return None
    expires = doc.get("expiresAt")
    if expires is not None and expires <= datetime.now(UTC):
        return None
    body = json.loads(doc["body_json"])
    body["cache"] = {"hit": True, "stored_utc": _iso(doc["storedAt"]), "key": key}
    return body


def _cache_put(key: str, body: dict, forecast: bool) -> None:
    now = datetime.now(UTC)
    doc = {"_id": key, "schema": CACHE_SCHEMA, "storedAt": now, "body_json": json.dumps(body)}
    if forecast:
        doc["expiresAt"] = now + timedelta(seconds=FORECAST_CACHE_SECONDS)
    try:
        get_cache_database()[COLLECTION].replace_one({"_id": key}, doc, upsert=True)
    except _MONGO_ERRORS:
        logger.warning("conditions cache write failed; continuing without it")


# --------------------------------------------------------------------------- assembly


def _sample_dicts(series_samples) -> list[dict]:
    return [{"t_utc": s.t_utc, "temp_c": s.temp_c, "rh_pct": s.rh_pct} for s in series_samples]


def _spinup(weather, result: dict, mode: str, start: datetime) -> tuple[list[dict], timedelta, dict]:
    """Hours before the window from the same source (station or reanalysis), and the table clock shift."""
    shift = timedelta(0)
    info = {"hours_requested": SPINUP_HOURS, "hours_used": 0, "source": None, "note": None}
    anchor = start.replace(minute=0, second=0, microsecond=0)
    if mode != "forecast" and result.get("source") == "open_meteo_era5":
        try:
            series = weather.fetch_reanalysis(result["lon"], result["lat"], anchor - timedelta(hours=SPINUP_HOURS),
                                              anchor - timedelta(hours=1))
        except (weather.WeatherError, ValueError, OSError) as exc:
            info["note"] = f"Spin-up fetch failed ({exc}); lagged classes start from the first day."
            return [], shift, info
        rows = _sample_dicts(series.samples)
        info.update(hours_used=len(rows), source="open_meteo_era5 (modelled, reanalysis)",
                    window_utc=[rows[0]["t_utc"], rows[-1]["t_utc"]] if rows else None)
        return rows, shift, info
    if mode == "forecast" or not result.get("station"):
        info["note"] = "No spin-up: the forecast has no earlier hours; lagged classes start from the first day."
        return [], shift, info
    if mode == "climatology_percentile":
        analog = (result.get("provenance") or {}).get("analog") or {}
        src = analog.get("source_start_utc")
        if src:
            source_start = weather.require_utc(src, "analog")
            shift = source_start - anchor
            anchor = source_start
    station = weather.Station(**result["station"])
    try:
        series = weather.fetch_history(station, anchor - timedelta(hours=SPINUP_HOURS),
                                       anchor - timedelta(hours=1))
    except (weather.WeatherError, ValueError, OSError) as exc:
        info["note"] = f"Spin-up fetch failed ({exc}); lagged classes start from the first day."
        return [], shift, info
    rows = _sample_dicts(series.samples)
    info.update(hours_used=len(rows), source=f"{station.source} {station.id}",
                window_utc=[rows[0]["t_utc"], rows[-1]["t_utc"]] if rows else None)
    return rows, shift, info


def build_conditions(params: dict) -> dict:
    """Weather plus derived moisture for validated ``params``. Raises sim.weather errors."""
    weather, fm, presets = _sim()
    lon, lat, start, hours, mode = (params[k] for k in ("lon", "lat", "start", "hours", "mode"))
    kwargs = {}
    if mode == "climatology_percentile":
        kwargs = {"percentile": params["percentile"], "sector": tuple(params["sector"])}
    if mode == "historical_replay" and params.get("station"):
        kwargs["station"] = params["station"]
    result = weather.scenario_wind(lon, lat, start, hours, mode, **kwargs)
    distance_km = (result.get("station") or {}).get("distance_km")
    if distance_km is not None and distance_km > MAX_STATION_DISTANCE_KM:
        st = result["station"]
        raise NoStationCoverage(
            f"Nearest station with data is {st['id']} ({st['name']}), {distance_km:.0f} km away "
            f"(limit {MAX_STATION_DISTANCE_KM:.0f} km). Use mode=historical_replay (it falls back to the "
            f"ERA5 reanalysis) or pick a nearer station."
        )
    add_20ft_wind(result)
    site = fm.Site(params["aspect"], params["slope_pct"], params["shading"], params["elevation"],
                   params["night_inversion"], params["station_aspect"]).validated()
    if params.get("phenology"):
        phen, phen_how = params["phenology"], "query parameter"
    else:
        phen, phen_how = presets.phenology_for_point(lon, lat, params.get("region"))
    spin_rows, shift, spin_info = _spinup(weather, result, mode, start)
    ms = fm.moisture_series(
        [{"t_utc": s["t_utc"], "temp_c": s["temp_c"], "rh_pct": s["rh_pct"]} for s in result["samples"]],
        lon, site, phen, spinup_samples=spin_rows, clock_shift=shift,
    )
    hours_out = []
    for s, m in zip(result["samples"], ms["hours"], strict=True):
        hours_out.append({
            "t_utc": s["t_utc"],
            "wind_speed_20ft_ms": s.get("speed_20ft_ms"),
            "wind_speed_20ft_mph": s.get("speed_20ft_mph"),
            "wind_speed_reported_ms": s.get("speed_ms"),
            "wind_from_deg": s.get("from_deg"),
            "gust_ms": s.get("gust_ms"),
            "temp_c": s.get("temp_c"),
            "rh_pct": s.get("rh_pct"),
            "n_obs": s.get("n_obs"),
            "moisture": m["moisture"],
            "fine_fuel": m["fine_fuel"],
            "dead_lag_pct": m["dead_lag_pct"],
            "live": m["live"],
            "met_filled": m["met_filled"],
        })
    return {
        "schema": "crisistwin.conditions/1",
        "model_version": fm.MODEL_VERSION,
        "query": {**{k: params[k] for k in ("lon", "lat", "hours", "mode")}, "start": _iso(start),
                  **({"station": params["station"]} if params.get("station") else {}),
                  **({"percentile": params["percentile"], "sector": params["sector"]}
                     if mode == "climatology_percentile" else {})},
        "mode": mode,
        "start_utc": result["start_utc"],
        "units": {
            "time": "UTC ISO 8601, hourly bin centre",
            "wind_speed_20ft_ms": "m/s, open 20 ft (6.1 m) wind after height_conversion",
            "wind_speed_20ft_mph": "miles per hour, same wind",
            "wind_speed_reported_ms": "m/s at the source's reporting height (height_conversion.from_height)",
            "wind_from_deg": "degrees true, the bearing the wind blows FROM",
            "gust_ms": "m/s as reported, not height-converted",
            "temp_c": "degC", "rh_pct": "percent",
            "moisture": "fraction of oven-dry weight (0.06 = 6 %), keys as rothermel.ts FuelMoisture",
            "fine_fuel": "percent, Rothermel 1983 table lookups",
            "dead_lag_pct": "percent",
        },
        "station": result.get("station"),
        "source": result.get("source"),
        "candidates": result.get("candidates", []),
        "warnings": result.get("warnings", []),
        "height_conversion": result.get("height_conversion"),
        "site": {"aspect": site.aspect, "slope_pct": site.slope_pct, "shading": site.shading,
                 "elevation_band": site.elevation_band, "night_inversion": site.night_inversion,
                 "station_aspect": site.station_aspect, "given": params["site_given"]},
        "phenology": {"class": phen, "label": fm.PHENOLOGY_CALENDARS[phen]["label"], "chosen_by": phen_how},
        "evidence": {
            "weather": result.get("evidence_label", result["evidence_class"]),
            "wind_20ft": "derived (station or reanalysis wind times the height_conversion factor)",
            "dead1h": "derived (Rothermel 1983 / Fosberg & Deeming tables from the hour's temperature and RH)",
            "dead10h_dead100h": ("derived (first-order timelag, tau 10 h and 100 h); forcing by the 1-h "
                                 "value and the starting state are assumed"),
            "live": "assumed (Rothermel 1983 Table II-2 stage values on an assumed regional calendar)",
            "site": "user" if params["site_given"] else "assumed defaults (aspect S, slope 0, exposed, level)",
        },
        "hours_series": hours_out,
        "summary": _summary(hours_out),
        "provenance": {
            "weather": result.get("provenance"),
            "weather_summary": result.get("summary"),
            "spinup": spin_info,
            "lag_initial_pct": ms["lag_initial_pct"],
            "table_clock": {
                "basis": "local mean solar time, UTC + lon/15 h",
                "shift_hours": shift.total_seconds() / 3600.0,
                "note": ("climatology analogs are relabelled to the scenario start; the moisture tables use "
                         "the hours the analog was really observed at") if shift else None,
            },
            "model": {
                "dead1h": ("Rothermel, R.C. 1983. How to predict the spread and intensity of forest and range "
                           "fires. USDA FS GTR INT-143, Exhibit II-2 Tables A-F (Fosberg & Deeming tables; "
                           "same as the NWCG IRPG)."),
                "dead10h_dead100h": "Timelag definition dm/dt = (E - m)/tau (Byram 1963; Fosberg 1970).",
                "live": "Rothermel 1983 Table II-2 stage values; phenology calendar assumed (sim/fuel_moisture.py).",
                "not_modelled": ("Precipitation and dew (the tables assume no recent rain: values are too dry "
                                 "after rain), cloud cover (use shading=shaded), wetting/drying hysteresis."),
            },
        },
    }


def _summary(hours: list[dict]) -> dict:
    winds = [h for h in hours if h["wind_speed_20ft_ms"] is not None]
    peak = max(winds, key=lambda h: h["wind_speed_20ft_ms"], default=None)  # earliest of ties
    dead = [h for h in hours if h["moisture"]["dead1h"] is not None]
    driest = min(dead, key=lambda h: h["moisture"]["dead1h"], default=None)
    gusts = [h["gust_ms"] for h in hours if h["gust_ms"] is not None]
    rhs = [h["rh_pct"] for h in hours if h["rh_pct"] is not None]
    temps = [h["temp_c"] for h in hours if h["temp_c"] is not None]
    return {
        "samples": len(hours),
        "hours_without_wind": len(hours) - len(winds),
        "hours_without_moisture": len(hours) - len(dead),
        "peak_wind_hour": None if peak is None else {
            "t_utc": peak["t_utc"], "wind_speed_20ft_mph": peak["wind_speed_20ft_mph"],
            "wind_speed_20ft_ms": peak["wind_speed_20ft_ms"], "wind_from_deg": peak["wind_from_deg"],
            "moisture": peak["moisture"],
        },
        "max_gust_ms": max(gusts, default=None),
        "min_dead1h": None if driest is None else {
            "t_utc": driest["t_utc"], "dead1h": driest["moisture"]["dead1h"],
            "rh_pct": driest["rh_pct"], "temp_c": driest["temp_c"],
        },
        "min_rh_pct": min(rhs, default=None),
        "max_temp_c": max(temps, default=None),
    }


# --------------------------------------------------------------------------- views


def _parse(q, weather, fm) -> tuple[dict | None, Response | None]:
    lon = _number(q.get("lon"), -180, 180)
    lat = _number(q.get("lat"), -90, 90)
    if lon is None or lat is None:
        return None, _error(400, "bad_point", "lon and lat are required, WGS84 degrees.")
    hours_raw = q.get("hours")
    hours = DEFAULT_HOURS if hours_raw is None else _number(hours_raw, 1, MAX_HOURS)
    if hours is None or hours != int(hours):
        return None, _error(400, "bad_hours", f"hours must be an integer from 1 to {MAX_HOURS}.")
    mode = q.get("mode", "historical_replay")
    if mode not in weather.MODES:
        return None, _error(400, "bad_mode", f"mode must be one of {', '.join(weather.MODES)}.")
    start_raw = q.get("start")
    if start_raw:
        start = _parse_start(start_raw)
        if start is None:
            return None, _error(400, "bad_start", "start must be ISO 8601 UTC ending in Z, e.g. 2018-11-08T00:00:00Z.")
    elif mode == "forecast":
        start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    else:
        return None, _error(400, "bad_start", "start is required for this mode.")
    p = {"lon": round(lon, 4), "lat": round(lat, 4), "hours": int(hours), "mode": mode,
         "start": start.replace(second=0, microsecond=0)}
    pct_raw = q.get("percentile")
    p["percentile"] = 95.0 if pct_raw is None else _number(pct_raw, 50, 99.9)
    if p["percentile"] is None:
        return None, _error(400, "bad_percentile", "percentile must be a number from 50 to 99.9.")
    sector_raw = q.get("sector")
    if sector_raw:
        parts = [_number(x, 0, 360) for x in sector_raw.split(",")]
        if len(parts) != 2 or None in parts:
            return None, _error(400, "bad_sector", "sector must be 'from,to' in degrees 0-360.")
        p["sector"] = [float(parts[0]), float(parts[1])]
    else:
        p["sector"] = [315.0, 90.0]  # sim/weather.py scenario_wind default
    site_keys = ("aspect", "slope_pct", "shading", "elevation", "night_inversion", "station_aspect")
    p["site_given"] = any(q.get(k) is not None for k in site_keys)
    aspect_raw = q.get("aspect", "S")
    try:
        aspect = fm.aspect_class(float(aspect_raw) if _number(aspect_raw, 0, 360) is not None else aspect_raw)
        station_aspect = fm.aspect_class(q.get("station_aspect", "S"))
    except ValueError as exc:
        return None, _error(400, "bad_aspect", str(exc))
    slope = _number(q.get("slope_pct", "0"), 0, 1000)
    if slope is None:
        return None, _error(400, "bad_slope", "slope_pct must be a number from 0 to 1000.")
    shading = q.get("shading", "exposed")
    if shading not in fm.SHADING:
        return None, _error(400, "bad_shading", f"shading must be one of {', '.join(fm.SHADING)}.")
    elevation = q.get("elevation", "L").upper()
    if elevation not in fm.ELEVATION_BANDS:
        return None, _error(400, "bad_elevation", "elevation must be B, L or A (relative to the weather station).")
    inversion = q.get("night_inversion", "0")
    if inversion not in ("0", "1"):
        return None, _error(400, "bad_inversion", "night_inversion must be 0 or 1.")
    p.update(aspect=aspect, slope_pct=slope, shading=shading, elevation=elevation,
             night_inversion=inversion == "1", station_aspect=station_aspect)
    p["region"] = q.get("region") or None
    p["phenology"] = q.get("phenology") or None
    if p["phenology"] and p["phenology"] not in fm.PHENOLOGY_CALENDARS:
        return None, _error(400, "bad_phenology", f"phenology must be one of {', '.join(fm.PHENOLOGY_CALENDARS)}.")
    station, station_err = parse_station(q.get("station"))
    if station_err:
        return None, _error(400, "bad_station", station_err)
    p["station"] = station if mode == "historical_replay" else None
    return p, None


def _cache_key(p: dict, fm, weather) -> str:
    parts = [fm.MODEL_VERSION, weather.SELECTION_VERSION, f"{p['lon']:.4f},{p['lat']:.4f}", _iso(p["start"]),
             str(p["hours"]), p["mode"], f"st={(p.get('station') or '').upper()}"]
    if p["mode"] == "climatology_percentile":
        parts += [f"p{p['percentile']:g}", "s{:g},{:g}".format(*p["sector"])]
    parts += [p["aspect"], f"{p['slope_pct']:g}", p["shading"], p["elevation"],
              f"inv{int(p['night_inversion'])}{p['station_aspect']}",
              f"r={p['region'] or ''}", f"ph={p['phenology'] or ''}"]
    return "|".join(parts)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([ConditionsThrottle])
def conditions(request):
    try:
        weather, fm, presets = _sim()
    except ImportError as exc:
        logger.exception("sim modules unavailable")
        return _error(503, "conditions_unavailable", f"sim modules could not be imported: {exc}")
    params, err = _parse(request.query_params, weather, fm)
    if err is not None:
        return err
    if params["region"] and presets.region_presets(params["region"]) is None:
        return _error(400, "bad_region", "region must be a catalogue region or historical fire id.")
    key = _cache_key(params, fm, weather)
    forecast = params["mode"] == "forecast"
    cache_header = "no-store" if forecast else "public, max-age=3600"
    if (hit := _cache_get(key)) is not None:
        return Response(hit, headers={"Cache-Control": cache_header})
    try:
        body = build_conditions(params)
    except NoStationCoverage as exc:
        return _error(502, "no_station_coverage", str(exc))
    except ValueError as exc:
        return _error(400, "bad_request", str(exc))
    except weather.WeatherError as exc:
        return _error(502, "weather_no_data", str(exc))
    except OSError as exc:
        return _error(503, "weather_unreachable", f"Weather source unreachable: {exc}")
    except Exception as exc:  # noqa: BLE001 - surface any upstream parse failure as 502
        logger.exception("conditions failed")
        return _error(502, "conditions_error", f"Conditions error: {type(exc).__name__}: {exc}")
    _cache_put(key, body, forecast)
    body["cache"] = {"hit": False, "stored_utc": None, "key": key}
    return Response(body, headers={"Cache-Control": cache_header})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def conditions_presets(request):
    try:
        _weather, fm, presets = _sim()
    except ImportError as exc:
        return _error(503, "conditions_unavailable", f"sim modules could not be imported: {exc}")
    region = request.query_params.get("region")
    common = {
        "phenology_classes": {k: v["label"] for k, v in fm.PHENOLOGY_CALENDARS.items()},
        "evidence_note": ("Typical season dates and phenology calendars are assumptions; historical "
                          "ignition times carry their source; weather evidence is set when the query runs."),
    }
    if region:
        rp = presets.region_presets(region)
        if rp is None:
            return _error(404, "unknown_region", "region must be a catalogue region or historical fire id.")
        return Response({**rp, **common}, headers={"Cache-Control": "public, max-age=3600"})
    regions = [presets.region_presets(rid) for rid in presets.all_region_ids()]
    return Response({"regions": regions, **common}, headers={"Cache-Control": "public, max-age=3600"})
