"""GET /api/weather/scenario: hourly scenario wind from `sim/weather.py`, with provenance.

Query: ``lon``, ``lat`` (WGS84 degrees), ``start`` (ISO 8601 UTC with Z; optional and defaulting to
the current UTC hour for ``forecast``), ``hours`` (1-72, default 24), ``mode``
(``historical_replay`` | ``climatology_percentile`` | ``forecast``), ``percentile`` (50-99.9,
``climatology_percentile`` only, default 95), ``station`` (``historical_replay`` only: an IEM
station id such as ``OAK``/``KOAK`` or ``JBGC1``, or ``reanalysis``; default: the best-ranked
station, see docs/scenario-weather.md "Station selection").

The body is `sim.weather.scenario_wind` unchanged (m/s, degrees FROM, hourly UTC; evidence class
and label, station, distance, ranked ``candidates``, ``warnings``, provenance), plus:

* ``samples[].speed_20ft_ms`` and ``speed_20ft_mph``: the station wind scaled to the open 20 ft
  height the Rothermel model expects (see ``height_conversion``). ``speed_ms`` stays as reported.
* ``height_conversion``: reporting height, factor, method and note, so the UI can label it.

Raw upstream responses are cached on the server by `sim.weather` (see docs/scenario-weather.md).
Errors: 400 bad query, 502 no data or upstream error, 503 upstream unreachable.
"""

import logging
import math
import re
import sys
from datetime import datetime, timezone

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

logger = logging.getLogger(__name__)

MAX_HOURS = 72
DEFAULT_HOURS = 24
MPH_PER_MS = 1 / 0.44704  # international mile 1609.344 m / 3600 s

# Log wind profile, neutral stability: u(z2)/u(z1) = ln(z2/z0) / ln(z1/z0). Open terrain with
# roughness length z0 = 0.2 m (between Davenport-Wieringa "roughly open" 0.1 m and "rough" 0.25 m)
# gives u(20 ft = 6.096 m) / u(10 m) = ln(30.48) / ln(50) = 0.873, the ~0.87 factor commonly
# quoted for 10 m to 20 ft. Applied as the constant 0.87.
FACTOR_10M_TO_20FT = 0.87
CONVERSION_METHOD = (
    "log wind profile, neutral stability, open terrain roughness length z0 = 0.2 m: "
    "u(6.096 m) / u(10 m) = ln(6.096/0.2) / ln(10/0.2) = 0.873, applied as 0.87"
)
CONVERSION_NOTE = (
    "Not checked against the terrain around the station. The solver's own midflame adjustment "
    "is applied afterwards, separately."
)


class ScenarioWeatherThrottle(AnonRateThrottle):
    scope = "scenario_weather"
    rate = "30/min"


def _sim_weather():
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)
    from sim import weather

    return weather


def _number(raw, low, high):
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) and low <= value <= high else None


_STATION_ID = re.compile(r"^[A-Za-z0-9_-]{2,16}$")


def parse_station(raw):
    """``station`` query value: an IEM station id (``OAK``/``KOAK``, ``JBGC1``) or ``reanalysis``.

    Returns ``(value_or_None, error_message_or_None)``.
    """
    if raw is None or raw == "":
        return None, None
    if not _STATION_ID.match(raw):
        return None, "station must be an IEM station id (letters, digits, - or _) or 'reanalysis'."
    return raw, None


def _parse_start(raw):
    if not raw or not raw.endswith("Z"):
        return None
    try:
        return datetime.fromisoformat(raw[:-1] + "+00:00").astimezone(timezone.utc)
    except ValueError:
        return None


def height_conversion(result: dict) -> dict:
    """Reporting height of the series and the factor to the open 20 ft wind."""
    station = result.get("station") or {}
    source = station.get("source") or result.get("source")
    if source == "iem_hads":
        return {
            "from_height": "20 ft (6.1 m), RAWS standard",
            "to_height": "20 ft open wind",
            "factor": 1.0,
            "method": "none: RAWS winds are already measured at 20 ft",
            "note": "Station exposure is not corrected.",
        }
    if source == "open_meteo_era5":
        return {
            "from_height": "10 m (ERA5 reanalysis, 0.25 deg grid cell)",
            "to_height": "20 ft open wind",
            "factor": FACTOR_10M_TO_20FT,
            "method": CONVERSION_METHOD,
            "note": CONVERSION_NOTE + " A reanalysis cell wind is already smoothed over the terrain.",
        }
    return {
        "from_height": "10 m (ASOS/AWOS or NWS gridpoint)",
        "to_height": "20 ft open wind",
        "factor": FACTOR_10M_TO_20FT,
        "method": CONVERSION_METHOD,
        "note": CONVERSION_NOTE,
    }


def add_20ft_wind(result: dict) -> dict:
    conversion = height_conversion(result)
    factor = conversion["factor"]
    for sample in result["samples"]:
        speed = sample.get("speed_ms")
        if speed is None:
            sample["speed_20ft_ms"] = None
            sample["speed_20ft_mph"] = None
        else:
            sample["speed_20ft_ms"] = round(speed * factor, 3)
            sample["speed_20ft_mph"] = round(speed * factor * MPH_PER_MS, 2)
    result["height_conversion"] = conversion
    result["units"] = {
        **result.get("units", {}),
        "speed_20ft_ms": "m/s, open 20 ft (6.1 m) wind after height_conversion",
        "speed_20ft_mph": "miles per hour, same wind",
    }
    return result


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([ScenarioWeatherThrottle])
def scenario_weather(request):
    q = request.query_params
    lon = _number(q.get("lon"), -180, 180)
    lat = _number(q.get("lat"), -90, 90)
    if lon is None or lat is None:
        return _error(400, "bad_point", "lon and lat are required, WGS84 degrees.")
    hours_raw = q.get("hours")
    hours = DEFAULT_HOURS if hours_raw is None else _number(hours_raw, 1, MAX_HOURS)
    if hours is None or hours != int(hours):
        return _error(400, "bad_hours", f"hours must be an integer from 1 to {MAX_HOURS}.")
    mode = q.get("mode", "historical_replay")
    try:
        weather = _sim_weather()
    except ImportError as exc:
        logger.exception("sim.weather unavailable")
        return _error(503, "weather_unavailable", f"sim.weather could not be imported: {exc}")
    if mode not in weather.MODES:
        return _error(400, "bad_mode", f"mode must be one of {', '.join(weather.MODES)}.")
    start_raw = q.get("start")
    if start_raw:
        start = _parse_start(start_raw)
        if start is None:
            return _error(400, "bad_start", "start must be ISO 8601 UTC ending in Z, e.g. 2018-11-08T00:00:00Z.")
    elif mode == "forecast":
        start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    else:
        return _error(400, "bad_start", "start is required for this mode.")
    kwargs = {}
    if mode == "climatology_percentile":
        pct_raw = q.get("percentile")
        percentile = 95.0 if pct_raw is None else _number(pct_raw, 50, 99.9)
        if percentile is None:
            return _error(400, "bad_percentile", "percentile must be a number from 50 to 99.9.")
        kwargs["percentile"] = percentile
    station, station_err = parse_station(q.get("station"))
    if station_err:
        return _error(400, "bad_station", station_err)
    if station and mode == "historical_replay":
        kwargs["station"] = station
    try:
        result = weather.scenario_wind(lon, lat, start, int(hours), mode, **kwargs)
    except ValueError as exc:
        return _error(400, "bad_request", str(exc))
    except weather.WeatherError as exc:
        return _error(502, "weather_no_data", str(exc))
    except OSError as exc:
        return _error(503, "weather_unreachable", f"Weather source unreachable: {exc}")
    except Exception as exc:  # noqa: BLE001 - surface any upstream parse failure as 502
        logger.exception("scenario weather failed")
        return _error(502, "weather_error", f"Weather source error: {type(exc).__name__}: {exc}")
    add_20ft_wind(result)
    # `forecast` is never cached upstream; the archives never change.
    cache = "no-store" if mode == "forecast" else "public, max-age=3600"
    return Response(result, headers={"Cache-Control": cache})
