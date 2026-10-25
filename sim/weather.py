"""Scenario weather: historical, climatological and forecast wind for a point in the western US.

Pure stdlib. Network access goes through one injectable ``http_get`` so the maths and the
parsers are testable offline (see ``tests/test_weather.py``). Design and terms of use:
``docs/scenario-weather.md`` and ``docs/adr/0045-scenario-weather.md``.

Conventions at every boundary of this module:

* Times are timezone-aware UTC ``datetime`` (naive datetimes are rejected) and ISO-8601
  strings ending in ``Z``. Hourly samples are labelled by the **centre** of their hour bin
  (observations within +/-30 min of HH:00 belong to HH:00).
* Speeds are metres per second (m/s), temperatures degrees Celsius, relative humidity percent
  (0-100), coordinates ``(lon, lat)`` in degrees WGS84, distances kilometres.
* Wind direction is meteorological: the bearing the wind blows **from**, degrees true,
  clockwise from north, in [0, 360). ``None`` means calm or not reported; a missing value is
  never replaced by a plausible-looking number.
* Heights are not converted. ASOS, gridpoint and ERA5 winds are 10 m, RAWS winds are 20 ft
  (6.1 m); the Rothermel input is the open 20 ft wind (same simplification as
  ``app/src/fire/weather.ts``).
* Elevations are metres above sea level; station-site differences are station minus site.
* Every series carries an evidence class: ``observed`` (station data), ``forecast`` (NWS
  gridpoint forecast), ``derived`` (chosen statistically from observations, see
  ``climatology_percentile``) or ``modelled`` (ERA5 reanalysis, ``fetch_reanalysis``).
* Every source's reports pass ``qc_observations`` (cited range, step and persistence checks)
  before hourly binning; failed values become ``None`` and are listed in ``provenance.obs_qc``.
* Station choice (``rank_stations``, ``score_station``) uses weights that are CrisisTwin
  assumptions, named as constants below and documented in docs/scenario-weather.md.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

OBSERVED = "observed"
FORECAST = "forecast"
DERIVED = "derived"
MODELLED = "modelled"  # reanalysis: a model's reconstruction of the past, not a measurement
EVIDENCE_LABELS = {
    OBSERVED: "observed",
    FORECAST: "forecast",
    DERIVED: "derived",
    MODELLED: "modelled (reanalysis)",
}

SELECTION_VERSION = "station-rank/1"
"""Version of the station choice below; API caches key on it so old answers are not served."""

# ---- station choice (historical_replay, climatology_percentile). Every weight is an ASSUMPTION
# chosen for CrisisTwin, not a published constant; docs/scenario-weather.md "Station selection".
MAX_CANDIDATES = 12
"""At most this many stations (wind-capable, archive covering the start) are ranked and tried."""
MAX_CANDIDATE_DISTANCE_KM = 60.0
"""Stations farther than this are not candidates; beyond it the reanalysis is used instead."""
SCORE_PER_KM = 1.0
"""Penalty points per km of horizontal distance (the score's unit is 'km-equivalent')."""
SCORE_PER_100M_ELEV = 5.0
"""ASSUMPTION: 100 m of station-site elevation difference costs as much as 5 km of distance.
Wind in complex terrain changes faster with height (ridge vs canyon vs valley floor) than with
horizontal distance; at this rate a 500 m difference equals 25 km."""
SCORE_ELEV_UNKNOWN = 5.0
"""Penalty when the station's or the site's elevation is unknown (as if 100 m off)."""
SCORE_SUMMIT = 15.0
"""ASSUMPTION: extra penalty for a summit/ridge/lookout station standing well above the site:
its wind is the free-air flow above the terrain, not the canyon or foothill wind at the site."""
SUMMIT_MIN_ABOVE_SITE_M = 300.0
"""A station counts as 'summit' only if its name says so AND it is this much above the site."""
SUMMIT_NAME = re.compile(r"\b(MOUNT|MT|MTN|PEAK|SUMMIT|LOOKOUT|RIDGE|BALDY|TOP)\b", re.I)
SCORE_RAWS_BONUS = -3.0
"""ASSUMPTION: RAWS are sited for fire weather in wildland terrain and measure the 20 ft wind
the fire model takes (no height conversion), so a RAWS is preferred over an airport at the same
distance and elevation. CrisisTwin sites are wildland or wildland-urban-interface fires."""
WARN_ELEV_DIFF_M = 500.0
"""Warn when the chosen station's elevation differs from the site's by more than this."""
WARN_DISTANCE_KM = 30.0
"""Warn when the chosen station is farther than this."""
MIN_STATION_COVERAGE = 0.5
"""ASSUMPTION: a best station covering less than this fraction of the window's hours is not
used; the hourly reanalysis is used instead (the stations stay listed)."""
REANALYSIS_ID = "reanalysis"
"""``station=`` value that forces the reanalysis."""

# ---- observation quality control (``qc_observations``), applied to every source at ingestion.
# A flagged value becomes missing (None); it is never replaced by a plausible-looking number.
QC_VERSION = "obs-qc/2"
"""Version of the QC and RH-gap fill below; API caches key on it so old answers are not served.
2: adds the hourly precipitation range check (``PRECIP_1H_RANGE_*``)."""
RH_RANGE_MIN_PCT = 0.01
RH_RANGE_MAX_PCT = 103.0
"""Synoptic Data QC range check (``sl_range_check``), Relative Humidity minimum 0.01 %, maximum
103 % (https://docs.synopticdata.com/services/mesonet-data-qc, read 2026-10-24). An RH of exactly
0 % fails it: the air would hold no water vapour (dew point minus infinity)."""
DEW_POINT_RANGE_MIN_C = -59.44
"""Synoptic Data QC range check (``sl_range_check``), Dew Point minimum -59.44 degC (-75 degF),
same page. Applied to the dew point implied by the report's temperature and RH."""
RH_STEP_MAX_PCT_PER_H = 50.0
"""NOAA MADIS surface QC, level 1 validity checks: "Relative humidity 1hr chng -50 - 50 %"
(https://madis.ncep.noaa.gov/madis_sfc_qc_notes.shtml, read 2026-10-24)."""
DEW_POINT_STEP_MAX_C_PER_H = 35.0 * 5.0 / 9.0
"""NOAA MADIS surface QC, level 2 temporal consistency checks: "Dewpoint temperature 35 F/hour"
(same page), i.e. 19.44 degC per hour."""
STEP_MAX_SEPARATION = timedelta(minutes=75)
"""ASSUMPTION: the hourly step limits above compare a report with the previous accepted report at
most this long before it (one hour plus 15 min for report-time jitter). Farther apart, no step test."""
PERSIST_WINDOW = timedelta(hours=24)
PERSIST_MIN_OBS = 24
RH_PERSIST_MIN_RANGE_PCT = 0.5
WIND_PERSIST_MIN_RANGE_MS = 0.25
"""Synoptic Data QC persistence check (``sl_pers_check``): over a 24 h evaluation period with at
least 24 observations, Relative Humidity must vary by 0.5 % and Wind Speed by 0.25 m/s (same page).
Synoptic's secondary persistence check also flags the gust when the speed persists. Shorter calm or
saturated runs stay valid."""
MAGNUS_A = 17.625
MAGNUS_B_C = 243.04
"""Magnus form of saturation vapour pressure over water, coefficients of Alduchov, O.A. and
Eskridge, R.E. 1996, Improved Magnus form approximation of saturation vapor pressure, J. Appl.
Meteor. 35, 601-609 (eq. 21; stated range -40 to 50 degC, extrapolated below for the range test)."""
PRECIP_1H_RANGE_MIN_MM = 0.0
PRECIP_1H_RANGE_MAX_MM = 254.0
"""Synoptic Data QC range check (``sl_range_check``), "Precipitation 1hr", minimum 0 mm, maximum
254 mm (https://docs.synopticdata.com/services/mesonet-data-qc, read 2026-10-25). Applied to every
hourly precipitation amount. (MADIS's validity range for accumulated precipitation, 0-44 in, is
wider; the stricter Synoptic limit is used.) Synoptic and MADIS list no step or persistence check
for precipitation, so none is applied."""
MM_PER_INCH = 25.4  # exact: 1 in = 25.4 mm
RH_GAP_FILL_MIN_HOURS = 4
"""RH gaps (after QC) at least this long are filled from a neighbouring station (``_fill_rh_gaps``);
shorter ones are interpolated by sim/fuel_moisture.py (``MAX_FILL_GAP_HOURS`` = 3, an assumption)."""
RH_DONOR_MAX_STATIONS = 3
"""ASSUMPTION: at most this many next-ranked stations are fetched as RH donors (bounds network use)."""

MODES = ("historical_replay", "climatology_percentile", "forecast")

KNOT_MS = 1852.0 / 3600.0  # exact: 1 knot = 1852 m / 3600 s
MPH_MS = 1609.344 / 3600.0  # exact: international mile
KMH_MS = 1000.0 / 3600.0

USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)"
IEM_ASOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
IEM_HADS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py"
IEM_NETWORK_URL = "https://mesonet.agron.iastate.edu/geojson/network/{network}.geojson"
NWS_POINTS_URL = "https://api.weather.gov/points/{lat:.4f},{lon:.4f}"
IEM_DCP_VARS_URL = "https://mesonet.agron.iastate.edu/json/dcp_vars.php?station={station}"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
USGS_EPQS_URL = "https://epqs.nationalmap.gov/v1/json"

REANALYSIS_MODEL = "era5"
"""Open-Meteo model id. ERA5 (ECMWF, 0.25 deg). Open-Meteo's ERA5-Land (0.1 deg) returns null
for 10 m wind and gusts (checked 2026-10-24), so it cannot be the wind source."""
REANALYSIS_GRID = "ERA5 0.25 deg x 0.25 deg (about 28 km N-S, 22 km E-W at 37 N), hourly"
REANALYSIS_LATENCY_DAYS = 6
"""ERA5 reaches the archive about 5 days after real time (Open-Meteo docs); answers for windows
ending later than this many days ago are not disk-cached (they may still be filling in)."""

SOURCE_TERMS = {
    "iem_asos": {
        "name": "Iowa Environmental Mesonet ASOS/AWOS archive (Iowa State University)",
        "url": "https://mesonet.agron.iastate.edu/request/download.phtml",
        "terms": "Public domain, free for any lawful purpose, no key. Attribution to the "
        "Iowa Environmental Mesonet appreciated. Per-IP rate limit: do not hammer.",
    },
    "iem_hads": {
        "name": "IEM DCP/HADS archive of NWS-relayed RAWS (GOES DCP) transmissions",
        "url": "https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py?help",
        "terms": "Same IEM terms (public domain, no key, per-IP throttle). RAWS stations "
        "are federal/state fire-weather stations relayed through NWS HADS.",
    },
    "nws_gridpoint": {
        "name": "NWS api.weather.gov gridpoint forecast",
        "url": "https://www.weather.gov/documentation/services-web-api",
        "terms": "Open data, free, no key, US Government public domain; a identifying "
        "User-Agent is required and an undisclosed rate limit applies. Do not present "
        "modified content as official NWS product.",
    },
    "open_meteo_era5": {
        "name": "Open-Meteo Historical Weather API, ECMWF ERA5 reanalysis (Copernicus Climate "
        "Change Service; Hersbach et al. 2020, QJRMS 146:1999-2049)",
        "url": "https://open-meteo.com/en/docs/historical-weather-api",
        "terms": "Free, no key, non-commercial use only (CrisisTwin is a non-commercial "
        "prototype); under 10,000 calls/day, 5,000/hour, 600/minute per IP; data CC BY 4.0, "
        "attribution 'Weather data by Open-Meteo.com' and Copernicus/ECMWF for ERA5 "
        "(https://open-meteo.com/en/terms, checked 2026-10-24).",
    },
    "usgs_epqs": {
        "name": "USGS 3DEP Elevation Point Query Service",
        "url": "https://epqs.nationalmap.gov/v1/docs",
        "terms": "US Government public domain, no key.",
    },
    "open_meteo_elevation": {
        "name": "Open-Meteo Elevation API (Copernicus DEM GLO-90)",
        "url": "https://open-meteo.com/en/docs/elevation-api",
        "terms": "Same Open-Meteo terms as above.",
    },
}

# SHEF physical-element codes used by the IEM HADS archive (English units).
HADS_WIND_SPEED = "USIRGZ"  # mph, sustained
HADS_WIND_DIR = "UDIRGZ"  # degrees true, from
HADS_WIND_PEAK = "UPHRGZ"  # mph, peak (gust)
HADS_TEMP = "TAIRGZ"  # deg F
HADS_RH = "XRIRGZ"  # percent
HADS_PRECIP_1H = "PPHRGZ"  # inches, precipitation increment over the hour ending at the report (SHEF PP, duration H)
HADS_PRECIP_ACCUM = "PCIRGZ"  # inches, precipitation accumulator (SHEF PC), used only when PPHRGZ is absent


class WeatherError(Exception):
    """A source could not be read, or returned something that does not parse."""


# --------------------------------------------------------------------------- helpers


def require_utc(value, name: str = "time") -> datetime:
    """Accept an aware datetime or an ISO string with an offset or 'Z'; return UTC."""
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z") or text.endswith("z"):
            text = text[:-1] + "+00:00"
        value = datetime.fromisoformat(text)
    if not isinstance(value, datetime):
        raise TypeError(f"{name} must be a datetime or ISO string")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware (UTC); got a naive datetime")
    return value.astimezone(timezone.utc)


def iso_z(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_deg(deg: float) -> float:
    """Normalise to [0, 360)."""
    return deg % 360.0


def angle_diff(a: float, b: float) -> float:
    """Signed smallest difference a - b in degrees, in (-180, 180]."""
    d = (a - b + 180.0) % 360.0 - 180.0
    return 180.0 if d == -180.0 else d


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def percentile_nearest_rank(values: Sequence[float], p: float) -> float:
    """Nearest-rank percentile (an actual member of ``values``), p in (0, 100]."""
    if not values:
        raise ValueError("no values")
    if not 0 < p <= 100:
        raise ValueError("percentile must be in (0, 100]")
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100.0 * len(ordered)))
    return ordered[rank - 1]


def _num(text: Optional[str]) -> Optional[float]:
    if text is None:
        return None
    text = text.strip()
    if text in ("", "M", "T", "NaN", "nan"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


# --------------------------------------------------------------------------- stations


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    lon: float
    lat: float
    source: str  # "iem_asos" or "iem_hads"
    network: str
    archive_begin: Optional[str] = None  # YYYY-MM-DD
    archive_end: Optional[str] = None  # None = still reporting
    distance_km: Optional[float] = None
    elevation_m: Optional[float] = None  # metres above sea level, IEM station metadata

    def active_at(self, t: datetime) -> bool:
        day = t.astimezone(timezone.utc).strftime("%Y-%m-%d")
        if self.archive_begin and day < self.archive_begin:
            return False
        if self.archive_end and day > self.archive_end:
            return False
        return True


def network_source(network: str) -> Optional[str]:
    """``XX_ASOS`` -> ``iem_asos`` (airports), ``XX_DCP`` -> ``iem_hads`` (RAWS relayed by HADS)."""
    if re.fullmatch(r"[A-Z]{2}_ASOS", network):
        return "iem_asos"
    if re.fullmatch(r"[A-Z]{2}_DCP", network):
        return "iem_hads"
    return None


def parse_station_geojson(text: str, network: str) -> list[Station]:
    """Parse an IEM ``/geojson/network/<NET>.geojson`` document into stations.

    ``XX_ASOS`` -> ASOS/AWOS airports (wind reported). ``XX_DCP`` mixes hydrologic gauges
    (no wind) with RAWS; only stations whose name contains "RAWS" are kept (the naming holds in
    CA_DCP and CO_DCP, checked 2026-10-24). Whether a RAWS actually has wind for a given window
    is only known from its data, so callers must check coverage (``scenario_wind`` does).
    """
    source = network_source(network)
    if source is None:
        raise ValueError(f"unsupported network {network!r}")
    doc = json.loads(text)
    out: list[Station] = []
    for f in doc.get("features", []):
        props = f.get("properties", {})
        coords = (f.get("geometry") or {}).get("coordinates")
        if not coords or len(coords) < 2:
            continue
        name = str(props.get("sname", ""))
        if source == "iem_hads" and "RAWS" not in name.upper():
            continue
        elev = props.get("elevation")
        out.append(
            Station(
                id=str(f.get("id") or props.get("sid")),
                name=name,
                lon=float(coords[0]),
                lat=float(coords[1]),
                source=source,
                network=network,
                archive_begin=props.get("archive_begin"),
                archive_end=props.get("archive_end"),
                elevation_m=float(elev) if isinstance(elev, (int, float)) else None,
            )
        )
    return out


def nearest_stations(
    lon: float,
    lat: float,
    k: int = 3,
    *,
    catalog: Optional[Sequence[Station]] = None,
    at: Optional[datetime] = None,
    sources: Optional[Iterable[str]] = None,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
) -> list[Station]:
    """The ``k`` stations nearest to ``(lon, lat)``, nearest first, with ``distance_km`` set.

    ``at`` (aware UTC) drops stations whose archive does not cover that instant.
    ``sources`` restricts to ``"iem_asos"`` and/or ``"iem_hads"``. ``catalog`` defaults to the
    cached IEM catalog of the states around the point (``states_for_point``; fetched once, then
    served from the disk cache).
    """
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError("coordinates are (lon, lat) in degrees")
    if k < 1:
        raise ValueError("k must be >= 1")
    stations = (
        list(catalog) if catalog is not None
        else load_catalog(http_get, cache_dir, states=states_for_point(lon, lat))
    )
    wanted = set(sources) if sources else None
    scored = []
    for s in stations:
        if wanted and s.source not in wanted:
            continue
        if at is not None and not s.active_at(require_utc(at, "at")):
            continue
        d = haversine_km(lon, lat, s.lon, s.lat)
        scored.append((d, s.id, s))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [
        Station(**{**asdict(s), "distance_km": round(d, 3)}) for d, _, s in scored[:k]
    ]


# State bounding boxes (lon_min, lat_min, lon_max, lat_max), degrees WGS84, US Census Bureau
# state extents rounded outward. ASSUMPTION: a rectangle is good enough to decide which IEM state
# networks can hold a station near a point; candidates are then filtered by true distance. Only
# the western states (where CrisisTwin's fire scenarios are) and Hawaii are listed.
STATE_BBOXES = {
    "CA": (-124.48, 32.53, -114.13, 42.01),
    "OR": (-124.57, 41.99, -116.46, 46.30),
    "WA": (-124.85, 45.54, -116.92, 49.00),
    "NV": (-120.01, 35.00, -114.04, 42.00),
    "AZ": (-114.82, 31.33, -109.04, 37.00),
    "UT": (-114.05, 37.00, -109.04, 42.00),
    "ID": (-117.24, 41.99, -111.04, 49.00),
    "MT": (-116.05, 44.36, -104.04, 49.00),
    "WY": (-111.06, 40.99, -104.05, 45.01),
    "CO": (-109.06, 36.99, -102.04, 41.00),
    "NM": (-109.05, 31.33, -103.00, 37.00),
    "HI": (-160.25, 18.91, -154.81, 22.24),
}
DEFAULT_STATES = ("CA",)  # what load_catalog served before the state lookup existed


def states_for_point(lon: float, lat: float, margin_km: Optional[float] = None) -> tuple[str, ...]:
    """States whose bounding box, grown by ``margin_km`` (default the candidate radius), holds the point.

    A point near a border gets both states' networks. A point outside every listed state gets
    ``()``: no station catalog, so ``scenario_wind`` goes straight to reanalysis.
    """
    m_km = MAX_CANDIDATE_DISTANCE_KM if margin_km is None else margin_km
    dlat = m_km / 111.0
    dlon = m_km / (111.0 * max(math.cos(math.radians(lat)), 0.1))
    return tuple(
        st for st, (x0, y0, x1, y1) in STATE_BBOXES.items()
        if x0 - dlon <= lon <= x1 + dlon and y0 - dlat <= lat <= y1 + dlat
    )


def load_catalog(
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
    states: Sequence[str] = DEFAULT_STATES,
) -> list[Station]:
    """ASOS and RAWS stations of the IEM ``<ST>_ASOS`` and ``<ST>_DCP`` networks of ``states``."""
    stations: list[Station] = []
    for st in states:
        for network in (f"{st}_ASOS", f"{st}_DCP"):
            body, _ = cached_get(
                IEM_NETWORK_URL.format(network=network), http_get=http_get, cache_dir=cache_dir
            )
            stations.extend(parse_station_geojson(body.decode("utf-8"), network))
    return stations


# --------------------------------------------------------------------------- disk cache


def default_cache_dir() -> Path:
    """Disk cache outside the repo: ``$CRISISTWIN_WEATHER_CACHE`` or ``~/.cache/crisistwin/weather``."""
    env = os.environ.get("CRISISTWIN_WEATHER_CACHE")
    return Path(env) if env else Path.home() / ".cache" / "crisistwin" / "weather"


def default_http_get(url: str, headers: Optional[dict] = None, timeout: float = 90.0) -> bytes:
    """GET with an identifying User-Agent; retries HTTP 429/503 (IEM throttles per IP) with backoff."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    delays = (3, 8, 20, 45)
    for attempt in range(len(delays) + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https only)
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503) and attempt < len(delays):
                time.sleep(delays[attempt])
                continue
            raise WeatherError(f"GET {url} failed: {exc}") from exc
        except Exception as exc:  # network, timeout
            raise WeatherError(f"GET {url} failed: {exc}") from exc
    raise WeatherError(f"GET {url} failed after retries")


def cached_get(
    url: str,
    *,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
    headers: Optional[dict] = None,
) -> tuple[bytes, dict]:
    """GET ``url`` through the disk cache. Returns ``(body, record)``.

    ``record`` = ``{url, file, bytes, sha256, retrieved_utc, from_cache}``; the same fields are
    kept in ``index.json`` beside the cached bodies. A cached file whose size or SHA-256 no
    longer matches the index is discarded and fetched again.
    """
    cdir = Path(cache_dir) if cache_dir is not None else default_cache_dir()
    cdir.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(url.encode()).hexdigest()[:32] + ".dat"
    path = cdir / name
    index_path = cdir / "index.json"
    try:
        index = json.loads(index_path.read_text())
    except (OSError, ValueError):
        index = {}
    rec = index.get(name)
    if rec and path.exists():
        body = path.read_bytes()
        if len(body) == rec["bytes"] and hashlib.sha256(body).hexdigest() == rec["sha256"]:
            return body, {**rec, "from_cache": True}
    get = http_get or default_http_get
    body = get(url, headers) if headers else get(url)
    rec = {
        "url": url,
        "file": name,
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "retrieved_utc": iso_z(datetime.now(timezone.utc)),
    }
    path.write_bytes(body)
    index[name] = rec
    index_path.write_text(json.dumps(index, indent=1, sort_keys=True))
    return body, {**rec, "from_cache": False}


# --------------------------------------------------------------------------- raw parsing


@dataclass(frozen=True)
class RawObs:
    """One station report in SI units. Direction is 'from', degrees true, or None if calm/unknown."""

    t: datetime
    speed_ms: Optional[float]
    from_deg: Optional[float]
    gust_ms: Optional[float]
    rh_pct: Optional[float]
    temp_c: Optional[float]
    precip_mm: Optional[float] = None  # precipitation in the hour ending at ``t`` (see each parser), mm


def _direction(deg: Optional[float], speed_ms: Optional[float]) -> Optional[float]:
    """Wind-from bearing in [0, 360), or None when calm or not meaningful.

    METAR reports north as 360 and calm as 000 with zero speed; a 000 with non-zero speed is
    not a valid report and is treated as unknown rather than guessed.
    """
    if deg is None or not speed_ms:
        return None
    if deg == 0.0:
        return None
    return norm_deg(deg)


def _inches_to_mm(value: Optional[float]) -> Optional[float]:
    return None if value is None else value * MM_PER_INCH


def parse_asos_csv(text: str) -> list[RawObs]:
    """IEM asos.py ``format=onlycomma`` with ``tz=Etc/UTC``; speeds in knots, temp deg F.

    ``p01i`` (inches) is IEM's "one hour precipitation for the period from the observation time to
    the time of the previous hourly precipitation reset" (asos.py help); it becomes ``precip_mm``.
    A trace (``T``) reads as 0.0 mm: below the gauge's 0.01 in resolution. ``M`` stays missing.
    """
    rows = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    out: list[RawObs] = []
    for r in csv.DictReader(rows):
        if "valid" not in r:
            raise WeatherError("ASOS CSV missing 'valid' column")
        t = datetime.strptime(r["valid"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
        kt, gk = _num(r.get("sknt")), _num(r.get("gust"))
        sp = None if kt is None else kt * KNOT_MS
        tf = _num(r.get("tmpf"))
        out.append(
            RawObs(
                t=t,
                speed_ms=sp,
                from_deg=_direction(_num(r.get("drct")), sp),
                gust_ms=None if gk is None else gk * KNOT_MS,
                rh_pct=_num(r.get("relh")),
                temp_c=None if tf is None else f_to_c(tf),
                precip_mm=0.0 if (r.get("p01i") or "").strip() == "T" else _inches_to_mm(_num(r.get("p01i"))),
            )
        )
    out.sort(key=lambda o: o.t)
    return out


def _shef6(row: dict) -> dict:
    """Map 7-character SHEF column names to the 6-character form.

    The IEM HADS archive labels columns with the 6-character code (``USIRGZ``) up to 2020 and
    with the full 7-character code including the probability letter (``USIRGZZ``) from 2021
    (checked 2026-10-24: JBGC1 2020-11-08 vs 2021-11-08). Reading only the 6-character name made
    every RAWS from 2021 on look windless. A 7-character code ending in the probability code
    ``Z`` (no probability) is the same series as its 6-character prefix.
    """
    out = {}
    for k, v in row.items():
        if k and len(k) == 7 and k.isupper() and k.endswith("Z"):
            out.setdefault(k[:6], v)
        else:
            out[k] = v
    return out


def parse_hads_csv(text: str) -> list[RawObs]:
    """IEM hads.py CSV (``what=txt``): SHEF columns in English units (mph, deg F).

    Several SHEF codes arrive on separate rows with different minutes; rows carrying a wind speed
    or direction become observations, and a row with only precipitation becomes a
    precipitation-only report (wind, RH and temperature ``None``, so it changes nothing else).
    Accepts both the 6- and the 7-character SHEF column names (see ``_shef6``).

    Precipitation (inches -> ``precip_mm``): ``PPHRGZ``, the increment over the hour ending at the
    report. Without it, the ``PCIRGZ`` accumulator difference from the previous accumulator report
    when that report is 45-75 min earlier (an hourly increment; ASSUMPTION: the same tolerance as
    ``STEP_MAX_SEPARATION``); a negative difference (accumulator reset) or another spacing is missing.
    """
    rows = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    out: list[RawObs] = []
    prev_acc: Optional[tuple[datetime, float]] = None
    for raw in csv.DictReader(rows):
        r = _shef6(raw)
        if "utc_valid" not in r:
            raise WeatherError("HADS CSV missing 'utc_valid' column")
        t = datetime.strptime(r["utc_valid"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        pp, acc = _num(r.get(HADS_PRECIP_1H)), _num(r.get(HADS_PRECIP_ACCUM))
        precip_in = pp
        if precip_in is None and acc is not None and prev_acc is not None:
            dt = t - prev_acc[0]
            if timedelta(minutes=45) <= dt <= STEP_MAX_SEPARATION and acc >= prev_acc[1]:
                precip_in = acc - prev_acc[1]
        if acc is not None:
            prev_acc = (t, acc)
        spd, dr = _num(r.get(HADS_WIND_SPEED)), _num(r.get(HADS_WIND_DIR))
        if spd is None and dr is None:
            if precip_in is not None:
                out.append(RawObs(t=t, speed_ms=None, from_deg=None, gust_ms=None, rh_pct=None,
                                  temp_c=None, precip_mm=_inches_to_mm(precip_in)))
            continue
        sp = None if spd is None else spd * MPH_MS
        pk, tf = _num(r.get(HADS_WIND_PEAK)), _num(r.get(HADS_TEMP))
        out.append(
            RawObs(
                t=t,
                speed_ms=sp,
                from_deg=_direction(dr, sp),
                gust_ms=None if pk is None else pk * MPH_MS,
                rh_pct=_num(r.get(HADS_RH)),
                temp_c=None if tf is None else f_to_c(tf),
                precip_mm=_inches_to_mm(precip_in),
            )
        )
    out.sort(key=lambda o: o.t)
    return out


# --------------------------------------------------------------------------- quality control


def dew_point_c(temp_c: float, rh_pct: float) -> float:
    """Dew point, degC, from air temperature (degC) and RH (percent, > 0): Magnus form inverted
    (Alduchov and Eskridge 1996 coefficients ``MAGNUS_A``, ``MAGNUS_B_C``)."""
    gamma = math.log(rh_pct / 100.0) + MAGNUS_A * temp_c / (MAGNUS_B_C + temp_c)
    return MAGNUS_B_C * gamma / (MAGNUS_A - gamma)


def rh_from_dew_point_pct(temp_c: float, dew_point_c_: float) -> float:
    """RH, percent, from air temperature and dew point (degC): e_s(Td) / e_s(T), same Magnus form."""
    return 100.0 * math.exp(MAGNUS_A * dew_point_c_ / (MAGNUS_B_C + dew_point_c_)
                            - MAGNUS_A * temp_c / (MAGNUS_B_C + temp_c))


def _persisting(values: list[tuple[datetime, float]], min_range: float) -> set[int]:
    """Indexes of values inside a ``PERSIST_WINDOW`` holding >= ``PERSIST_MIN_OBS`` values whose
    range (max - min) is below ``min_range`` (Synoptic ``sl_pers_check``)."""
    flagged: set[int] = set()
    j = 0
    for i, (t, _) in enumerate(values):
        while values[j][0] < t - PERSIST_WINDOW:
            j += 1
        window = [v for _, v in values[j:i + 1]]
        if len(window) >= PERSIST_MIN_OBS and max(window) - min(window) < min_range:
            flagged.update(range(j, i + 1))
    return flagged


def qc_observations(obs: Sequence[RawObs]) -> tuple[list[RawObs], dict]:
    """Quality-control RH and wind speed of time-ordered reports; failed values become ``None``.

    RH, in order (the range test gates the others, as Synoptic's does):

    1. range: ``RH_RANGE_MIN_PCT`` <= RH <= ``RH_RANGE_MAX_PCT`` (Synoptic ``sl_range_check``),
       and the implied dew point >= ``DEW_POINT_RANGE_MIN_C`` (same check, dew point row);
    2. step: against the previous accepted RH report at most ``STEP_MAX_SEPARATION`` earlier,
       |dRH| <= ``RH_STEP_MAX_PCT_PER_H`` and |dTd| <= ``DEW_POINT_STEP_MAX_C_PER_H`` (MADIS);
    3. persistence: RH varying by less than ``RH_PERSIST_MIN_RANGE_PCT`` over 24 h (Synoptic).

    Wind: speed varying by less than ``WIND_PERSIST_MIN_RANGE_MS`` over 24 h (Synoptic
    ``sl_pers_check``) removes speed, direction and gust (secondary persistence check).

    Precipitation: ``PRECIP_1H_RANGE_MIN_MM`` <= amount <= ``PRECIP_1H_RANGE_MAX_MM`` (Synoptic
    ``sl_range_check``, "Precipitation 1hr").

    Returns ``(reports, record)``; ``record`` lists every removed value with its check.
    """
    removed: list[dict] = []
    rh_ok: list[Optional[float]] = []
    for o in obs:
        rh = o.rh_pct
        if rh is not None:
            why = None
            if not (RH_RANGE_MIN_PCT <= rh <= RH_RANGE_MAX_PCT):
                why = "rh_range"
            elif o.temp_c is not None and dew_point_c(o.temp_c, rh) < DEW_POINT_RANGE_MIN_C:
                why = "dew_point_range"
            if why:
                removed.append({"t_utc": iso_z(o.t), "variable": "rh_pct", "value": rh,
                                "temp_c": o.temp_c, "check": why})
                rh = None
        rh_ok.append(rh)
    # Step tests against the last accepted report (a flagged value never becomes the reference).
    ref: Optional[int] = None
    step_flag: set[int] = set()
    for i, o in enumerate(obs):
        rh = rh_ok[i]
        if rh is None:
            continue
        if ref is not None and o.t - obs[ref].t <= STEP_MAX_SEPARATION:
            r_rh, r_t = rh_ok[ref], obs[ref].temp_c
            why = None
            if abs(rh - r_rh) > RH_STEP_MAX_PCT_PER_H:
                why = "rh_step"
            elif (o.temp_c is not None and r_t is not None
                  and abs(dew_point_c(o.temp_c, rh) - dew_point_c(r_t, r_rh)) > DEW_POINT_STEP_MAX_C_PER_H):
                why = "dew_point_step"
            if why:
                step_flag.add(i)
                removed.append({"t_utc": iso_z(o.t), "variable": "rh_pct", "value": rh,
                                "temp_c": o.temp_c, "check": why,
                                "reference": {"t_utc": iso_z(obs[ref].t), "rh_pct": r_rh, "temp_c": r_t}})
                continue
        ref = i
    for i in step_flag:
        rh_ok[i] = None
    rh_vals = [(obs[i].t, rh_ok[i], i) for i in range(len(obs)) if rh_ok[i] is not None]
    for k in _persisting([(t, v) for t, v, _ in rh_vals], RH_PERSIST_MIN_RANGE_PCT):
        i = rh_vals[k][2]
        removed.append({"t_utc": iso_z(obs[i].t), "variable": "rh_pct", "value": rh_ok[i],
                        "temp_c": obs[i].temp_c, "check": "rh_persistence"})
        rh_ok[i] = None
    sp_vals = [(o.t, o.speed_ms, i) for i, o in enumerate(obs) if o.speed_ms is not None]
    wind_bad = {sp_vals[k][2] for k in _persisting([(t, v) for t, v, _ in sp_vals], WIND_PERSIST_MIN_RANGE_MS)}
    for i in sorted(wind_bad):
        removed.append({"t_utc": iso_z(obs[i].t), "variable": "speed_ms", "value": obs[i].speed_ms,
                        "check": "wind_persistence"})
    precip_bad: set[int] = set()
    for i, o in enumerate(obs):
        if o.precip_mm is not None and not (PRECIP_1H_RANGE_MIN_MM <= o.precip_mm <= PRECIP_1H_RANGE_MAX_MM):
            precip_bad.add(i)
            removed.append({"t_utc": iso_z(o.t), "variable": "precip_mm", "value": o.precip_mm,
                            "check": "precip_range"})
    out = []
    for i, o in enumerate(obs):
        if i in wind_bad:
            o = replace(o, speed_ms=None, from_deg=None, gust_ms=None)
        if rh_ok[i] != o.rh_pct:
            o = replace(o, rh_pct=rh_ok[i])
        if i in precip_bad:
            o = replace(o, precip_mm=None)
        out.append(o)
    removed.sort(key=lambda r: (r["t_utc"], r["variable"]))
    counts: dict[str, int] = {}
    for r in removed:
        counts[r["check"]] = counts.get(r["check"], 0) + 1
    record = {
        "version": QC_VERSION,
        "n_reports": len(obs),
        "n_rh_reports": sum(1 for o in obs if o.rh_pct is not None),
        "n_removed": len(removed),
        "counts": counts,
        "removed": removed,
        "checks": {
            "rh_range": {"min_pct": RH_RANGE_MIN_PCT, "max_pct": RH_RANGE_MAX_PCT,
                         "source": "Synoptic Data QC sl_range_check"},
            "dew_point_range": {"min_c": DEW_POINT_RANGE_MIN_C, "source": "Synoptic Data QC sl_range_check",
                                "dew_point": "Magnus form, Alduchov and Eskridge 1996"},
            "rh_step": {"max_pct_per_h": RH_STEP_MAX_PCT_PER_H,
                        "source": "NOAA MADIS surface QC validity check 'Relative humidity 1hr chng'"},
            "dew_point_step": {"max_c_per_h": round(DEW_POINT_STEP_MAX_C_PER_H, 2),
                               "source": "NOAA MADIS surface QC temporal consistency, dewpoint 35 F/hour"},
            "step_max_separation_min": STEP_MAX_SEPARATION.total_seconds() / 60.0,
            "step_reference": "previous accepted report (assumption: separation limit)",
            "rh_persistence": {"window_h": PERSIST_WINDOW.total_seconds() / 3600.0, "min_obs": PERSIST_MIN_OBS,
                               "min_range_pct": RH_PERSIST_MIN_RANGE_PCT, "source": "Synoptic Data QC sl_pers_check"},
            "wind_persistence": {"window_h": PERSIST_WINDOW.total_seconds() / 3600.0, "min_obs": PERSIST_MIN_OBS,
                                 "min_range_ms": WIND_PERSIST_MIN_RANGE_MS,
                                 "source": "Synoptic Data QC sl_pers_check (+ secondary check on gust)"},
            "precip_range": {"min_mm": PRECIP_1H_RANGE_MIN_MM, "max_mm": PRECIP_1H_RANGE_MAX_MM,
                             "source": "Synoptic Data QC sl_range_check, Precipitation 1hr"},
        },
    }
    return out, record


def _qc_samples(samples: list) -> tuple[list, dict]:
    """``qc_observations`` for already-hourly samples (forecast): same checks, same record."""
    obs = [RawObs(t=require_utc(s.t_utc, "t"),
                  speed_ms=s.speed_ms, from_deg=s.from_deg, gust_ms=s.gust_ms, rh_pct=s.rh_pct,
                  temp_c=s.temp_c, precip_mm=s.precip_mm) for s in samples]
    clean, record = qc_observations(obs)
    out = [replace(s, speed_ms=o.speed_ms, from_deg=o.from_deg, gust_ms=o.gust_ms, rh_pct=o.rh_pct,
                   precip_mm=o.precip_mm)
           for s, o in zip(samples, clean)]
    return out, record


def _time_runs(times: list[str]) -> list[tuple[str, str, int]]:
    """Group ISO-Z times into runs no more than ``STEP_MAX_SEPARATION`` apart: (first, last, n)."""
    runs: list[list] = []
    for ts in sorted(times):
        t = require_utc(ts, "t")
        if runs and t - runs[-1][3] <= STEP_MAX_SEPARATION:
            runs[-1][1], runs[-1][2], runs[-1][3] = ts, runs[-1][2] + 1, t
        else:
            runs.append([ts, ts, 1, t])
    return [(a, b, n) for a, b, n, _ in runs]


_QC_LABELS = {
    "rh_range": "RH outside 0.01-103 % (Synoptic range check)",
    "dew_point_range": "implied dew point below -59.44 degC (Synoptic range check)",
    "rh_step": "RH step over 50 % in an hour (MADIS)",
    "dew_point_step": "dew point step over 35 degF in an hour (MADIS)",
    "rh_persistence": "RH unchanging for 24 h (Synoptic persistence check)",
    "wind_persistence": "wind speed unchanging for 24 h (Synoptic persistence check)",
    "precip_range": "hourly precipitation outside 0-254 mm (Synoptic range check)",
}


def qc_warning(record: Optional[dict], label: str) -> Optional[str]:
    """One warning sentence for a ``qc_observations`` record, or None when nothing was removed."""
    if not record or not record.get("n_removed"):
        return None
    parts = []
    for check, n in sorted(record["counts"].items()):
        runs = _time_runs([r["t_utc"] for r in record["removed"] if r["check"] == check])
        when = ", ".join(a[:16] + "Z" if a == b else f"{a[:16]}Z-{b[11:16]}Z" for a, b, _ in runs[:4])
        more = f" and {len(runs) - 4} more runs" if len(runs) > 4 else ""
        values = sorted({r["value"] for r in record["removed"] if r["check"] == check})
        shown = ", ".join(f"{v:g}" for v in values[:4]) + (", ..." if len(values) > 4 else "")
        parts.append(f"{n} x {_QC_LABELS.get(check, check)} [values {shown}] at {when}{more}")
    return (f"Quality control removed {record['n_removed']} observation value(s) from {label}: "
            + "; ".join(parts) + ". Removed values are treated as missing, not replaced.")


# --------------------------------------------------------------------------- hourly series


@dataclass
class HourlySample:
    t_utc: str  # centre of the hour bin, ISO Z
    speed_ms: Optional[float]
    from_deg: Optional[float]
    gust_ms: Optional[float]
    rh_pct: Optional[float]
    temp_c: Optional[float]
    n_obs: int = 0
    rh_from: Optional[str] = None  # station id when rh_pct was filled from a neighbour (_fill_rh_gaps)
    precip_mm: Optional[float] = None  # precipitation in the hour ending near t_utc, mm (hourly_series)


@dataclass
class WeatherSeries:
    evidence_class: str
    source: str
    station: Optional[dict]
    samples: list[HourlySample]
    provenance: dict = field(default_factory=dict)
    units: dict = field(
        default_factory=lambda: {
            "speed": "m/s",
            "gust": "m/s",
            "direction": "degrees true, wind blows FROM, clockwise from north",
            "temperature": "degC",
            "relative_humidity": "percent",
            "precipitation": "mm, amount in the hour ending near the bin time (largest hourly amount "
                             "reported in the bin); null = not reported",
            "time": "UTC, hourly bin centre",
        }
    )

    def to_dict(self) -> dict:
        return asdict(self)

    def coverage(self) -> float:
        if not self.samples:
            return 0.0
        ok = sum(1 for s in self.samples if s.speed_ms is not None)
        return ok / len(self.samples)


def _mean(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def hourly_series(
    obs: Sequence[RawObs], start: datetime, end: datetime
) -> list[HourlySample]:
    """Bin reports to hourly samples covering ``[start, end]`` (both rounded to the hour).

    A report belongs to the hour whose HH:00 is nearest (HH:30 rounds up). Speed is the mean of
    the reports; direction is the speed-weighted vector mean (calm reports excluded); gust is
    the maximum reported gust, never synthesised. Hours with no report stay in the series
    with ``None`` values so gaps are visible.

    ``precip_mm`` is the largest hourly amount reported in the bin, not a sum. ASSUMPTION: every
    source's value is already an amount for the hour ending at the report (HADS ``PPHRGZ``; ASOS
    ``p01i`` accumulates since the last hourly reset, so the routine report carries the hour's
    total and specials carry part of it; ERA5 is the preceding hour's sum), so summing would count
    the same rain twice. ``n_obs`` counts reports with wind, RH or temperature, not
    precipitation-only rows.
    """
    start, end = require_utc(start, "start"), require_utc(end, "end")
    h0 = start.replace(minute=0, second=0, microsecond=0)
    if start - h0 >= timedelta(minutes=30):
        h0 += timedelta(hours=1)
    h1 = end.replace(minute=0, second=0, microsecond=0)
    if end - h1 >= timedelta(minutes=30):
        h1 += timedelta(hours=1)
    bins: dict[datetime, list[RawObs]] = {}
    for o in obs:
        c = o.t.replace(minute=0, second=0, microsecond=0)
        if o.t - c >= timedelta(minutes=30):
            c += timedelta(hours=1)
        if h0 <= c <= h1:
            bins.setdefault(c, []).append(o)
    out: list[HourlySample] = []
    t = h0
    while t <= h1:
        group = bins.get(t, [])
        speeds = [o.speed_ms for o in group if o.speed_ms is not None]
        gusts = [o.gust_ms for o in group if o.gust_ms is not None]
        east = north = 0.0
        for o in group:
            if o.speed_ms and o.from_deg is not None:
                rad = math.radians(o.from_deg)
                east += o.speed_ms * math.sin(rad)
                north += o.speed_ms * math.cos(rad)
        direction = None
        if math.hypot(east, north) > 1e-9:
            direction = norm_deg(math.degrees(math.atan2(east, north)))
        out.append(
            HourlySample(
                t_utc=iso_z(t),
                speed_ms=_mean(speeds),
                from_deg=direction,
                gust_ms=max(gusts) if gusts else None,
                rh_pct=_mean([o.rh_pct for o in group if o.rh_pct is not None]),
                temp_c=_mean([o.temp_c for o in group if o.temp_c is not None]),
                n_obs=sum(1 for o in group if (o.speed_ms, o.from_deg, o.gust_ms, o.rh_pct, o.temp_c)
                          != (None, None, None, None, None)),
                precip_mm=max((o.precip_mm for o in group if o.precip_mm is not None), default=None),
            )
        )
        t += timedelta(hours=1)
    return out


def history_url(station: Station, start: datetime, end: datetime) -> str:
    s = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")  # minute precision
    e = end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    if station.source == "iem_asos":
        q = [
            ("station", station.id),
            ("data", "tmpf"),
            ("data", "relh"),
            ("data", "drct"),
            ("data", "sknt"),
            ("data", "gust"),
            ("data", "p01i"),
            ("sts", s),
            ("ets", e),
            ("tz", "Etc/UTC"),
            ("format", "onlycomma"),
            ("missing", "M"),
            ("trace", "T"),
            ("report_type", "3"),  # routine METAR
            ("report_type", "4"),  # specials
        ]
        return IEM_ASOS_URL + "?" + urllib.parse.urlencode(q)
    if station.source == "iem_hads":
        q = [
            ("network", station.network),
            ("stations", station.id),
            ("sts", s),
            ("ets", e),
            ("what", "txt"),
            ("delimiter", "comma"),
            ("tz", "UTC"),
        ]
        return IEM_HADS_URL + "?" + urllib.parse.urlencode(q)
    raise ValueError(f"unknown station source {station.source!r}")


def fetch_history(
    station: Station,
    start_utc: datetime,
    end_utc: datetime,
    *,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
) -> WeatherSeries:
    """Observed hourly series for ``station`` over ``[start_utc, end_utc]`` (inclusive hours).

    Raw responses are cached on disk (outside the repo, see ``default_cache_dir``); the series
    provenance records the URL, byte size and SHA-256 of what was parsed.
    """
    start, end = require_utc(start_utc, "start_utc"), require_utc(end_utc, "end_utc")
    if end <= start:
        raise ValueError("end_utc must be after start_utc")
    # Pad by 30 min so edge-hour bins are complete.
    url = history_url(station, start - timedelta(minutes=30), end + timedelta(minutes=30))
    body, rec = cached_get(url, http_get=http_get, cache_dir=cache_dir)
    text = body.decode("utf-8", errors="replace")
    if text.lstrip().startswith("[{") or "Invalid" in text[:200]:
        raise WeatherError(f"{station.id}: source rejected the request: {text[:200]}")
    parse = parse_asos_csv if station.source == "iem_asos" else parse_hads_csv
    obs = parse(text)
    return series_from_obs(station, obs, start, end, rec)


def series_from_obs(
    station: Station, obs: Sequence[RawObs], start: datetime, end: datetime, rec: Optional[dict]
) -> WeatherSeries:
    """Hourly series from parsed reports, after ``qc_observations`` (record in ``provenance.obs_qc``)."""
    clean, qc = qc_observations(obs)
    samples = hourly_series(clean, start, end)
    return WeatherSeries(
        evidence_class=OBSERVED,
        source=station.source,
        station=asdict(station),
        samples=samples,
        provenance={
            "terms": SOURCE_TERMS[station.source],
            "raw": rec,
            "n_raw_reports": len(obs),
            "hour_binning": "nearest HH:00 (+/-30 min); speed mean, direction vector mean, gust max",
            "obs_qc": qc,
        },
    )


# --------------------------------------------------------------------------- NWS forecast

_DUR = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$")


def parse_iso_duration(text: str) -> timedelta:
    m = _DUR.match(text)
    if not m:
        raise WeatherError(f"unsupported ISO duration {text!r}")
    d, h, mi = (int(x) if x else 0 for x in m.groups())
    return timedelta(days=d, hours=h, minutes=mi)


_UOM_TO_MS = {
    "wmoUnit:km_h-1": KMH_MS,
    "wmoUnit:m_s-1": 1.0,
    "wmoUnit:kn": KNOT_MS,
    "wmoUnit:mi_h-1": MPH_MS,
}


def _expand_layer(layer: dict, convert: Callable[[float], float]) -> dict[datetime, float]:
    out: dict[datetime, float] = {}
    for item in layer.get("values", []):
        if item.get("value") is None:
            continue
        start_s, dur_s = item["validTime"].split("/")
        t0 = require_utc(start_s, "validTime")
        n = int(parse_iso_duration(dur_s).total_seconds() // 3600)
        for i in range(max(n, 1)):
            out[t0 + timedelta(hours=i)] = convert(float(item["value"]))
    return out


def _expand_amount_layer(layer: dict) -> dict[datetime, float]:
    """An accumulation layer (``quantitativePrecipitation``) spread over its hours, mm per hour.

    Each value is the amount over its ``validTime`` period (often 6 h); every hour of the period gets
    amount / hours. ASSUMPTION: uniform within the period (the forecast does not say when in it the
    rain falls). Each share is keyed by the END of its hour (``t0 + i + 1``), the station convention
    (amount in the hour ending at t).
    """
    uom = layer.get("uom", "wmoUnit:mm")
    if uom != "wmoUnit:mm":
        raise WeatherError(f"unsupported unit {uom!r} for quantitativePrecipitation")
    out: dict[datetime, float] = {}
    for item in layer.get("values", []):
        if item.get("value") is None:
            continue
        start_s, dur_s = item["validTime"].split("/")
        t0 = require_utc(start_s, "validTime")
        n = max(int(parse_iso_duration(dur_s).total_seconds() // 3600), 1)
        for i in range(n):
            out[t0 + timedelta(hours=i + 1)] = float(item["value"]) / n
    return out


def parse_gridpoint(doc: dict, start: datetime, hours: int) -> list[HourlySample]:
    """Hourly samples from an api.weather.gov ``/gridpoints/{wfo}/{x},{y}`` document.

    NWS gridpoint wind is the sustained 10 m wind, ``windDirection`` is already the bearing the
    wind blows FROM. Hours outside the forecast horizon keep ``None`` values.
    """
    props = doc["properties"]

    def speed_layer(name: str) -> dict[datetime, float]:
        layer = props.get(name) or {}
        uom = layer.get("uom", "wmoUnit:km_h-1")
        if uom not in _UOM_TO_MS:
            raise WeatherError(f"unsupported unit {uom!r} for {name}")
        f = _UOM_TO_MS[uom]
        return _expand_layer(layer, lambda v: v * f)

    speed = speed_layer("windSpeed")
    gust = speed_layer("windGust")
    direction = _expand_layer(props.get("windDirection") or {}, norm_deg)
    rh = _expand_layer(props.get("relativeHumidity") or {}, float)
    temp = _expand_layer(props.get("temperature") or {}, float)
    precip = _expand_amount_layer(props.get("quantitativePrecipitation") or {})
    t0 = require_utc(start, "start").replace(minute=0, second=0, microsecond=0)
    out = []
    for i in range(hours + 1):
        t = t0 + timedelta(hours=i)
        sp = speed.get(t)
        out.append(
            HourlySample(
                t_utc=iso_z(t),
                speed_ms=sp,
                from_deg=None if sp == 0 else direction.get(t),
                gust_ms=gust.get(t),
                rh_pct=rh.get(t),
                temp_c=temp.get(t),
                n_obs=0,
                precip_mm=precip.get(t),
            )
        )
    return out


def fetch_forecast(
    lon: float, lat: float, start: datetime, hours: int, *, http_get: Optional[Callable] = None
) -> WeatherSeries:
    """NWS gridpoint forecast for ``(lon, lat)``. Never cached: a stale forecast is worse than none."""
    get = http_get or default_http_get
    headers = {"Accept": "application/geo+json"}
    points_url = NWS_POINTS_URL.format(lat=lat, lon=lon)
    points = json.loads(get(points_url, headers))
    grid_url = points["properties"]["forecastGridData"]
    raw = get(grid_url, headers)
    doc = json.loads(raw)
    samples, qc = _qc_samples(parse_gridpoint(doc, start, hours))
    return WeatherSeries(
        evidence_class=FORECAST,
        source="nws_gridpoint",
        station=None,
        samples=samples,
        provenance={
            "terms": SOURCE_TERMS["nws_gridpoint"],
            "points_url": points_url,
            "grid_url": grid_url,
            "forecast_update_time": doc["properties"].get("updateTime"),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "height_note": "10 m sustained wind, no conversion to 20 ft",
            "obs_qc": qc,
        },
    )


# --------------------------------------------------------------------------- climatology


@dataclass(frozen=True)
class Episode:
    start_utc: str
    hours: int
    peak_ms: float
    index: int  # index into the hourly list it came from
    year: int


def in_sector(deg: Optional[float], sector: tuple[float, float]) -> bool:
    """True if ``deg`` lies in the clockwise arc ``sector = (from_deg, to_deg)`` inclusive."""
    if deg is None:
        return False
    lo, hi = norm_deg(sector[0]), norm_deg(sector[1])
    d = norm_deg(deg)
    return lo <= d <= hi if lo <= hi else (d >= lo or d <= hi)


def find_episodes(
    samples: Sequence[HourlySample],
    sector: tuple[float, float] = (315.0, 90.0),
    min_speed_ms: float = 5.0,
    min_hours: int = 6,
    max_gap_hours: int = 1,
) -> list[tuple[int, int, float]]:
    """Wind episodes in an hourly series: ``[(first_index, n_hours, peak_ms), ...]``.

    An episode is a run of hours with sustained wind from ``sector`` (default north-northwest
    through east, the offshore quadrant for most California fire-wind events) at or above
    ``min_speed_ms``, tolerating gaps of up to ``max_gap_hours`` hours, lasting at least
    ``min_hours`` hours.
    """
    eps: list[tuple[int, int, float]] = []
    first = last = None
    peak = 0.0
    for i, s in enumerate(samples):
        ok = s.speed_ms is not None and s.speed_ms >= min_speed_ms and in_sector(s.from_deg, sector)
        if ok:
            if first is None:
                first, peak = i, 0.0
            last = i
            peak = max(peak, s.speed_ms)
        elif first is not None and i - last > max_gap_hours:
            if last - first + 1 >= min_hours:
                eps.append((first, last - first + 1, peak))
            first = last = None
    if first is not None and last - first + 1 >= min_hours:
        eps.append((first, last - first + 1, peak))
    return eps


def select_percentile_episode(
    episodes: Sequence[tuple[int, int, float]], percentile: float
) -> tuple[int, int, float]:
    """The episode whose peak is the nearest-rank ``percentile`` of all episode peaks."""
    if not episodes:
        raise WeatherError("no wind episodes found for this station, month and sector")
    target = percentile_nearest_rank([e[2] for e in episodes], percentile)
    return min((e for e in episodes if e[2] == target), key=lambda e: e[0])


CLIMATOLOGY_YEARS = (2012, 2025)  # inclusive default analog window; documented, not wall-clock


def climatology_percentile(
    lon: float,
    lat: float,
    start: datetime,
    hours: int,
    *,
    percentile: float = 95.0,
    sector: tuple[float, float] = (315.0, 90.0),
    years: tuple[int, int] = CLIMATOLOGY_YEARS,
    catalog: Optional[Sequence[Station]] = None,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
) -> WeatherSeries:
    """A ``percentile`` offshore wind event for the calendar month of ``start``.

    Method (evidence class ``derived``): pool the nearest long-record ASOS station's hourly
    observations for that month across ``years``; find offshore-wind episodes (``find_episodes``);
    take the episode whose peak sustained speed is the nearest-rank ``percentile`` of all episode
    peaks; use that episode's real hours (continuing into the days after it) as the scenario
    series, re-labelled to begin at ``start``. Every value is a real observation but the choice
    of day is statistical, so it is NOT a replay of a named event; the source episode is listed
    in ``provenance.analog``.
    """
    start = require_utc(start, "start")
    y0, y1 = years
    # Station: the best-scored long-record ASOS (score_station, same weights as historical_replay;
    # RAWS are not used here: their HADS records are too patchy for a 14-year pool). Without one
    # within MAX_CANDIDATE_DISTANCE_KM, the nearest long-record ASOS as before.
    at0 = datetime(y0, 1, 1, tzinfo=timezone.utc)
    site = site_elevation(lon, lat, http_get=http_get, cache_dir=cache_dir)
    ranked, _ = rank_stations(
        lon, lat, at0, site_elev_m=site["elevation_m"], catalog=catalog, sources=["iem_asos"],
        check_wind=False, http_get=http_get, cache_dir=cache_dir,
    )
    sel_warnings: list[str] = []
    if ranked:
        st, chosen = ranked[0]
    else:
        cands = nearest_stations(lon, lat, 1, catalog=catalog, sources=["iem_asos"], at=at0,
                                 http_get=http_get, cache_dir=cache_dir)
        if not cands:
            raise WeatherError("no ASOS station with an archive covering the climatology window")
        st = cands[0]
        chosen = {"station": st.id, "id": st.id, "name": st.name, "source": st.source,
                  "network": st.network, "lon": st.lon, "lat": st.lat, "distance_km": st.distance_km,
                  "elevation_m": st.elevation_m, "rank": None, **score_station(st, site["elevation_m"])}
        ranked = [(st, chosen)]
    for _, info in ranked:
        info.update(status="not_tried", reason=_why(info))
    chosen.update(status="chosen")
    sel_warnings.extend(station_warnings(chosen))
    month = start.month
    pool: list[tuple[int, list[HourlySample], dict]] = []
    all_eps: list[tuple[int, int, int, float]] = []  # (year_idx, first, n, peak)
    raw_records = []
    for year in range(y0, y1 + 1):
        m0 = datetime(year, month, 1, tzinfo=timezone.utc)
        m1 = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=timezone.utc)
        # Fetch the month plus the requested scenario length so the analog can run past month end.
        series = fetch_history(
            st, m0, m1 + timedelta(hours=hours), http_get=http_get, cache_dir=cache_dir
        )
        raw_records.append(series.provenance["raw"])
        yi = len(pool)
        pool.append((year, series.samples, series.provenance.get("obs_qc")))
        n_month = int((m1 - m0).total_seconds() // 3600)
        for first, n, peak in find_episodes(series.samples[:n_month], sector):
            all_eps.append((yi, first, n, peak))
    if not all_eps:
        raise WeatherError("no offshore-wind episodes in the climatology window")
    peaks = [e[3] for e in all_eps]
    target = percentile_nearest_rank(peaks, percentile)
    yi, first, n, peak = min((e for e in all_eps if e[3] == target), key=lambda e: (e[0], e[1]))
    year, samples, year_qc = pool[yi]
    window = samples[first : first + hours + 1]
    t0 = require_utc(window[0].t_utc, "analog")
    analog_qc = None
    if year_qc:
        # Only removals inside the analog window (+/-30 min bins) concern this answer.
        lo = t0 - timedelta(minutes=30)
        hi = require_utc(window[-1].t_utc, "analog") + timedelta(minutes=30)
        kept = [r for r in year_qc["removed"] if lo <= require_utc(r["t_utc"], "qc") < hi]
        counts: dict[str, int] = {}
        for r in kept:
            counts[r["check"]] = counts.get(r["check"], 0) + 1
        analog_qc = {**year_qc, "removed": kept, "n_removed": len(kept), "counts": counts,
                     "note": "removals within the analog window, at the hours really observed"}
    shift = start.replace(minute=0, second=0, microsecond=0) - t0
    relabelled = [
        HourlySample(**{**asdict(s), "t_utc": iso_z(require_utc(s.t_utc, "s") + shift)})
        for s in window
    ]
    pooled_speed = [s.speed_ms for _, ss, _ in pool for s in ss
                    if s.speed_ms is not None and in_sector(s.from_deg, sector)]
    return WeatherSeries(
        evidence_class=DERIVED,
        source="climatology_percentile",
        station=asdict(st),
        samples=relabelled,
        provenance={
            "terms": SOURCE_TERMS["iem_asos"],
            "method": f"{percentile:g}th-percentile offshore-wind episode (by peak sustained speed)",
            "month": month,
            "years": [y0, y1],
            "sector_from_deg": list(sector),
            "n_episodes": len(all_eps),
            "episode_peak_percentile_ms": target,
            "pooled_in_sector_hourly_p95_ms": (
                percentile_nearest_rank(pooled_speed, 95) if pooled_speed else None
            ),
            "analog": {
                "source_start_utc": window[0].t_utc,
                "episode_hours": n,
                "episode_peak_ms": peak,
                "year": year,
                "note": "real observed hours chosen statistically; relabelled to start at the scenario start",
            },
            "station_selection": {
                "version": SELECTION_VERSION,
                "rule": "best-scored long-record ASOS within %g km (score_station), else the nearest"
                        % MAX_CANDIDATE_DISTANCE_KM,
                "site": site,
                "chosen": {k2: chosen.get(k2) for k2 in (
                    "id", "name", "distance_km", "elevation_m", "elevation_diff_m", "exposure",
                    "score", "score_terms")},
                "candidates": [info for _, info in ranked],
                "warnings": sel_warnings,
            },
            "raw": raw_records,
            "obs_qc": analog_qc,
        },
    )


# --------------------------------------------------------------------------- site elevation


def _get_once(url: str, headers: Optional[dict] = None, timeout: float = 15.0) -> bytes:
    """Single GET, short timeout, no retries: for optional lookups that must not stall a request."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https only)
            return resp.read()
    except Exception as exc:  # network, timeout, HTTP error
        raise WeatherError(f"GET {url} failed: {exc}") from exc


def site_elevation(
    lon: float, lat: float, *, http_get: Optional[Callable] = None, cache_dir: Optional[Path] = None
) -> dict:
    """Ground elevation at the site, metres above sea level: ``{elevation_m, source, url}``.

    USGS 3DEP point query first (US only), then the Open-Meteo elevation API (Copernicus
    GLO-90, global). ``elevation_m`` is ``None`` with ``errors`` when both fail; the station
    ranking then scores elevation as unknown instead of guessing.
    """
    lon_r, lat_r = round(lon, 4), round(lat, 4)
    get = http_get or _get_once
    errors = []
    url = USGS_EPQS_URL + "?" + urllib.parse.urlencode(
        {"x": lon_r, "y": lat_r, "wkid": 4326, "units": "Meters", "includeDate": "false"}
    )
    try:
        body, _ = cached_get(url, http_get=get, cache_dir=cache_dir)
        value = float(json.loads(body)["value"])
        if -500.0 < value < 9000.0:  # EPQS answers -1000000 outside its coverage
            return {"elevation_m": round(value, 1), "source": "usgs_epqs",
                    "dataset": "USGS 3DEP (best available, 1/3 arc-second where present)", "url": url}
        errors.append(f"usgs_epqs: no data ({value})")
    except Exception as exc:  # noqa: BLE001 - an optional lookup; fall through
        errors.append(f"usgs_epqs: {exc}")
    url = OPEN_METEO_ELEVATION_URL + "?" + urllib.parse.urlencode({"latitude": lat_r, "longitude": lon_r})
    try:
        body, _ = cached_get(url, http_get=get, cache_dir=cache_dir)
        value = float(json.loads(body)["elevation"][0])
        return {"elevation_m": round(value, 1), "source": "open_meteo_elevation",
                "dataset": "Copernicus DEM GLO-90", "url": url}
    except Exception as exc:  # noqa: BLE001
        errors.append(f"open_meteo_elevation: {exc}")
    return {"elevation_m": None, "source": None, "errors": errors}


# --------------------------------------------------------------------------- station ranking


def hads_wind_listed(
    station_id: str, *, http_get: Optional[Callable] = None, cache_dir: Optional[Path] = None
) -> Optional[bool]:
    """Does IEM list a wind-speed variable (SHEF ``USIRG*``) for this DCP station?

    ``True`` listed, ``False`` the station lists variables but no wind speed (a gauge or a RAWS
    whose anemometer is not relayed), ``None`` unknown (empty list or lookup failed). The list
    describes the station's current variables; it is cached on disk per station (clear the
    weather cache to refresh). Only ``False`` excludes a station.
    """
    url = IEM_DCP_VARS_URL.format(station=urllib.parse.quote(station_id))
    try:
        body, _ = cached_get(url, http_get=http_get or _get_once, cache_dir=cache_dir)
        ids = [str(v.get("id", "")) for v in json.loads(body).get("vars", [])]
    except Exception:  # noqa: BLE001 - unknown, not excluded
        return None
    if not ids:
        return None
    return any(i.startswith(HADS_WIND_SPEED[:5]) for i in ids)


def score_station(st: Station, site_elev_m: Optional[float]) -> dict:
    """Representativeness penalty of ``st`` for the site (lower is better), with its terms.

    ``score = SCORE_PER_KM * distance_km + SCORE_PER_100M_ELEV * |dz| / 100 m + summit + type``
    with ``dz = station elevation - site elevation`` (m). Weights: see the constants above
    (assumptions, docs/scenario-weather.md "Station selection").
    """
    d_km = st.distance_km if st.distance_km is not None else 0.0
    terms = {"distance": round(SCORE_PER_KM * d_km, 2)}
    if st.elevation_m is None or site_elev_m is None:
        dz = None
        terms["elevation"] = SCORE_ELEV_UNKNOWN
    else:
        dz = st.elevation_m - site_elev_m
        terms["elevation"] = round(SCORE_PER_100M_ELEV * abs(dz) / 100.0, 2)
    named_summit = bool(SUMMIT_NAME.search(st.name))
    summit = named_summit and (dz is None or dz >= SUMMIT_MIN_ABOVE_SITE_M)
    raws = st.source == "iem_hads"
    terms["exposure"] = SCORE_SUMMIT if summit else 0.0
    terms["type"] = SCORE_RAWS_BONUS if raws else 0.0
    if summit:
        exposure = "summit/ridge (name) above the site"
    elif raws:
        exposure = "RAWS (fire-weather station, 20 ft wind)"
    else:
        exposure = "airport ASOS/AWOS (open exposure, 10 m wind)"
    return {
        "score": round(sum(terms.values()), 2),
        "score_terms": terms,
        "elevation_diff_m": None if dz is None else round(dz, 1),
        "exposure": exposure,
    }


def _why(c: dict) -> str:
    t = c["score_terms"]
    parts = [f"{c['distance_km']:.1f} km"]
    dz = c.get("elevation_diff_m")
    parts.append("elevation unknown (+%g)" % t["elevation"] if dz is None
                 else f"{abs(dz):.0f} m {'above' if dz >= 0 else 'below'} the site (+{t['elevation']:g})")
    if t["exposure"]:
        parts.append(f"summit/ridge (+{t['exposure']:g})")
    if t["type"]:
        parts.append(f"RAWS ({t['type']:g})")
    return f"score {c['score']:g} = " + ", ".join(parts)


def station_warnings(c: dict) -> list[str]:
    """Why the chosen station may not represent the site (empty when it looks representative)."""
    out = []
    dz = c.get("elevation_diff_m")
    if dz is not None and abs(dz) > WARN_ELEV_DIFF_M:
        out.append(f"{c['name']} ({c['id']}) is {abs(dz):.0f} m {'above' if dz > 0 else 'below'} the site "
                   f"(more than {WARN_ELEV_DIFF_M:.0f} m): its wind may not represent the site.")
    if c.get("distance_km") is not None and c["distance_km"] > WARN_DISTANCE_KM:
        out.append(f"{c['name']} ({c['id']}) is {c['distance_km']:.0f} km from the site "
                   f"(more than {WARN_DISTANCE_KM:.0f} km).")
    if c["score_terms"].get("exposure"):
        out.append(f"{c['name']} ({c['id']}) is a summit/ridge station: free-air wind, not canyon or valley wind.")
    if dz is None:
        out.append("Station or site elevation unknown: elevation was not checked.")
    return out


def rank_stations(
    lon: float,
    lat: float,
    at: datetime,
    *,
    site_elev_m: Optional[float],
    catalog: Optional[Sequence[Station]] = None,
    sources: Optional[Iterable[str]] = None,
    k: int = MAX_CANDIDATES,
    max_km: float = MAX_CANDIDATE_DISTANCE_KM,
    check_wind: bool = True,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
) -> tuple[list[tuple[Station, dict]], list[dict]]:
    """Up to ``k`` wind-capable stations within ``max_km`` whose archive covers ``at``, best first.

    Returns ``(ranked, excluded)``: ``ranked`` = ``[(station, info)]`` ordered by
    ``score_station`` (ties: nearer, then id); ``excluded`` = RAWS skipped because IEM lists no
    wind variable for them (``hads_wind_listed`` is ``False``), as info dicts.
    """
    near = nearest_stations(lon, lat, 100_000, catalog=catalog, at=at, sources=sources,
                            http_get=http_get, cache_dir=cache_dir)
    scored = []
    for st in near:
        if st.distance_km is None or st.distance_km > max_km:
            continue
        info = {"station": st.id, "id": st.id, "name": st.name, "source": st.source,
                "network": st.network, "lon": st.lon, "lat": st.lat,
                "distance_km": st.distance_km, "elevation_m": st.elevation_m,
                **score_station(st, site_elev_m)}
        scored.append((info["score"], st.distance_km, st.id, st, info))
    scored.sort(key=lambda x: x[:3])
    ranked, excluded = [], []
    for _, _, _, st, info in scored:
        if len(ranked) >= k:
            break
        if check_wind and st.source == "iem_hads":
            listed = hads_wind_listed(st.id, http_get=http_get, cache_dir=cache_dir)
            info["wind_listed"] = listed
            if listed is False:
                excluded.append({**info, "status": "no_wind_sensor",
                                 "reason": "IEM lists no wind-speed variable for this DCP station"})
                continue
        ranked.append((st, info))
    for i, (_, info) in enumerate(ranked, start=1):
        info["rank"] = i
    return ranked, excluded


# --------------------------------------------------------------------------- reanalysis


def reanalysis_url(lon: float, lat: float, start: datetime, end: datetime) -> str:
    q = {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "start_date": start.astimezone(timezone.utc).strftime("%Y-%m-%d"),
        "end_date": end.astimezone(timezone.utc).strftime("%Y-%m-%d"),
        "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m,"
                  "precipitation",
        "precipitation_unit": "mm",
        "models": REANALYSIS_MODEL,
        "wind_speed_unit": "ms",
        "temperature_unit": "celsius",
        "timezone": "GMT",
    }
    return OPEN_METEO_ARCHIVE_URL + "?" + urllib.parse.urlencode(q)


def parse_open_meteo(doc: dict) -> list[RawObs]:
    """Open-Meteo archive ``hourly`` arrays (``wind_speed_unit=ms``, deg C, %, GMT) to reports.

    Times are HH:00 UTC. Wind, temperature and RH are the model's instantaneous values at that
    time; the gust is the maximum over the preceding hour (ERA5 'since previous post-processing').
    ``precipitation`` is "total precipitation (rain, showers, snow) sum of the preceding hour", mm
    (Open-Meteo Historical Weather API docs): modelled, not gauged.
    Direction is where the wind blows FROM (0 = north is valid here, unlike METAR).
    """
    h = doc.get("hourly") or {}
    times = h.get("time") or []
    out = []
    for i, ts in enumerate(times):
        def col(name):
            vals = h.get(name) or []
            return vals[i] if i < len(vals) else None
        t = datetime.strptime(ts, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        sp, dr = col("wind_speed_10m"), col("wind_direction_10m")
        out.append(RawObs(
            t=t,
            speed_ms=None if sp is None else float(sp),
            from_deg=None if (dr is None or not sp) else norm_deg(float(dr)),
            gust_ms=None if col("wind_gusts_10m") is None else float(col("wind_gusts_10m")),
            rh_pct=None if col("relative_humidity_2m") is None else float(col("relative_humidity_2m")),
            temp_c=None if col("temperature_2m") is None else float(col("temperature_2m")),
            precip_mm=None if col("precipitation") is None else float(col("precipitation")),
        ))
    return out


def fetch_reanalysis(
    lon: float,
    lat: float,
    start_utc: datetime,
    end_utc: datetime,
    *,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
) -> WeatherSeries:
    """Hourly ERA5 reanalysis at the site from Open-Meteo, evidence class ``modelled``.

    10 m wind and gust, 2 m temperature and RH. A grid-cell value smooths terrain: canyon and
    downslope winds are under-read. Windows ending within ``REANALYSIS_LATENCY_DAYS`` of now are
    not disk-cached (the archive may still be filling them in).
    """
    start, end = require_utc(start_utc, "start_utc"), require_utc(end_utc, "end_utc")
    if end <= start:
        raise ValueError("end_utc must be after start_utc")
    url = reanalysis_url(lon, lat, start, end)
    recent = end > datetime.now(timezone.utc) - timedelta(days=REANALYSIS_LATENCY_DAYS)
    if recent:
        body = (http_get or default_http_get)(url)
        rec = {"url": url, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
               "retrieved_utc": iso_z(datetime.now(timezone.utc)), "from_cache": False,
               "not_cached": "window within the reanalysis latency"}
    else:
        body, rec = cached_get(url, http_get=http_get, cache_dir=cache_dir)
    try:
        doc = json.loads(body)
    except ValueError as exc:
        raise WeatherError(f"reanalysis: unparseable answer: {exc}") from exc
    if doc.get("error"):
        raise WeatherError(f"reanalysis: {doc.get('reason') or doc}")
    obs, qc = qc_observations(parse_open_meteo(doc))
    samples = hourly_series(obs, start, end)
    g_lat, g_lon = doc.get("latitude"), doc.get("longitude")
    return WeatherSeries(
        evidence_class=MODELLED,
        source="open_meteo_era5",
        station=None,
        samples=samples,
        provenance={
            "terms": SOURCE_TERMS["open_meteo_era5"],
            "raw": rec,
            "model": REANALYSIS_MODEL,
            "grid": {
                "resolution": REANALYSIS_GRID,
                "point_lat": g_lat,
                "point_lon": g_lon,
                "point_distance_km": (None if g_lat is None or g_lon is None
                                      else round(haversine_km(lon, lat, g_lon, g_lat), 2)),
                "elevation_m": doc.get("elevation"),
                "elevation_note": "elevation Open-Meteo reports for the point (it adjusts 2 m "
                                  "temperature to it); the ERA5 cell itself is a 0.25 deg mean",
            },
            "heights": "wind and gust 10 m above ground; temperature and RH 2 m",
            "time_basis": "instantaneous model value at HH:00 UTC (wind, temperature, RH); gust = "
                          "maximum over the preceding hour; precipitation = sum over the preceding hour",
            "limits": "A 0.25 deg grid cell smooths terrain: canyon, gap and downslope winds "
                      "(Santa Ana, Diablo, Front Range) are usually under-read.",
            "obs_qc": qc,
        },
    )


# --------------------------------------------------------------------------- scenario_wind


def _find_station(station_id: str, lon: float, lat: float, catalog, http_get, cache_dir) -> Station:
    """Station ``station_id`` (IEM id; a 4-letter ICAO ``Kxxx`` also matches ``xxx``) with its distance."""
    want = station_id.strip().upper()
    ids = {want}
    if len(want) == 4 and want.startswith("K"):
        ids.add(want[1:])
    for st in nearest_stations(lon, lat, 100_000, catalog=catalog, http_get=http_get, cache_dir=cache_dir):
        if st.id.upper() in ids:
            return st
    raise ValueError(
        f"station {station_id!r} is not an ASOS or RAWS station in the networks around this point "
        f"({', '.join(states_for_point(lon, lat)) or 'none'})"
    )


def _reanalysis_option(lon: float, lat: float) -> dict:
    return {"station": REANALYSIS_ID, "id": REANALYSIS_ID, "name": "ERA5 reanalysis (Open-Meteo)",
            "source": "open_meteo_era5", "distance_km": None, "elevation_m": None,
            "exposure": "model grid cell, " + REANALYSIS_GRID, "evidence_class": MODELLED}


def _rh_gap_runs(samples: Sequence[HourlySample]) -> list[tuple[int, int]]:
    """Index ranges ``[i, j)`` of consecutive hours without RH, at least ``RH_GAP_FILL_MIN_HOURS`` long."""
    runs, i = [], 0
    while i < len(samples):
        if samples[i].rh_pct is not None:
            i += 1
            continue
        j = i
        while j < len(samples) and samples[j].rh_pct is None:
            j += 1
        if j - i >= RH_GAP_FILL_MIN_HOURS:
            runs.append((i, j))
        i = j
    return runs


def _fill_rh_gaps(
    ser: WeatherSeries, chosen: Station, ranked: Sequence[tuple[Station, dict]], start, end,
    *, http_get, cache_dir,
) -> tuple[Optional[dict], list[str]]:
    """Fill long RH gaps of the chosen station's series from the next-ranked stations.

    For each hour of a gap of at least ``RH_GAP_FILL_MIN_HOURS`` hours, the donor's dew point
    (from its QC-passed temperature and RH) is combined with the chosen station's own temperature:
    ``RH = e_s(Td_donor) / e_s(T_station)``, at most 100 %. ASSUMPTION: dew point carries across
    neighbouring stations better than RH (RH follows each site's temperature; Synoptic's spatial
    check likewise compares humidity through derived dew point). Donors: up to
    ``RH_DONOR_MAX_STATIONS`` next-ranked stations within ``WARN_DISTANCE_KM`` and
    ``WARN_ELEV_DIFF_M`` of the site (the existing warning limits, assumptions), in rank order.
    Hours with no station temperature or no donor stay missing. Mutates ``ser.samples``.
    """
    runs = _rh_gap_runs(ser.samples)
    if not runs:
        return None, []
    gap_idx = [i for a, b in runs for i in range(a, b)]
    filled: dict[int, dict] = {}
    donors_used: list[dict] = []
    tried = 0
    for st, info in ranked:
        if st.id == chosen.id or tried >= RH_DONOR_MAX_STATIONS:
            continue
        if (st.distance_km or 0.0) > WARN_DISTANCE_KM or abs(info.get("elevation_diff_m") or 0.0) > WARN_ELEV_DIFF_M:
            continue
        tried += 1
        try:
            donor = fetch_history(st, start, end, http_get=http_get, cache_dir=cache_dir)
        except WeatherError:
            continue
        by_t = {s.t_utc: s for s in donor.samples}
        n = 0
        for i in gap_idx:
            s = ser.samples[i]
            d = by_t.get(s.t_utc)
            if i in filled or s.temp_c is None or d is None or d.rh_pct is None or d.temp_c is None:
                continue
            td = dew_point_c(d.temp_c, d.rh_pct)
            rh = min(100.0, rh_from_dew_point_pct(s.temp_c, td))
            filled[i] = {"t_utc": s.t_utc, "donor": st.id, "donor_rh_pct": d.rh_pct,
                         "donor_temp_c": d.temp_c, "donor_dew_point_c": round(td, 2), "rh_pct": round(rh, 2)}
            ser.samples[i] = replace(s, rh_pct=rh, rh_from=st.id)
            n += 1
        if n:
            donors_used.append({"id": st.id, "name": st.name, "distance_km": st.distance_km,
                                "elevation_diff_m": info.get("elevation_diff_m"), "hours": n})
        if len(filled) == len(gap_idx):
            break
    left = [ser.samples[i].t_utc for i in gap_idx if i not in filled]
    record = {
        "rule": ("RH gaps >= %d h after QC: donor dew point with the station's temperature; donors are the "
                 "next-ranked stations within %g km and %g m (assumption)"
                 % (RH_GAP_FILL_MIN_HOURS, WARN_DISTANCE_KM, WARN_ELEV_DIFF_M)),
        "gaps": [{"from_utc": ser.samples[a].t_utc, "to_utc": ser.samples[b - 1].t_utc, "hours": b - a}
                 for a, b in runs],
        "donors": donors_used,
        "filled": [filled[i] for i in sorted(filled)],
        "still_missing_utc": left,
    }
    gaps = ", ".join(f"{g['from_utc'][:13]}Z-{g['to_utc'][11:13]}Z" for g in record["gaps"])
    msg = f"{chosen.id} has no usable RH for {len(gap_idx)} h ({gaps}) after quality control"
    if donors_used:
        msg += "; filled %d h from %s (neighbour dew point with %s temperature, assumption)" % (
            len(filled), ", ".join(f"{d['id']} {d['distance_km']:.1f} km ({d['hours']} h)" for d in donors_used),
            chosen.id)
    if left:
        msg += (f"; {len(left)} h stay missing (the moisture model interpolates gaps of up to 3 h; longer "
                "ones get no moisture and the fire run skips them)")
    return record, [msg + "."]


def _historical(
    lon, lat, start, end, *, k, min_coverage, forced, catalog, http_get, cache_dir
) -> tuple[WeatherSeries, list[dict], dict, list[str]]:
    """historical_replay: rank, fetch in rank order, fall back to reanalysis. See ``scenario_wind``."""
    site = site_elevation(lon, lat, http_get=http_get, cache_dir=cache_dir)
    states = states_for_point(lon, lat) if catalog is None else None
    warnings: list[str] = []
    if site["elevation_m"] is None:
        warnings.append("Site elevation unknown (USGS 3DEP and Open-Meteo lookups failed): "
                        "stations were ranked without the elevation check.")
    ranked, excluded = rank_stations(
        lon, lat, start, site_elev_m=site["elevation_m"], catalog=catalog, k=k,
        http_get=http_get, cache_dir=cache_dir,
    )
    selection = {
        "version": SELECTION_VERSION,
        "rule": ("rank wind-capable stations within %g km whose archive covers the start by score "
                 "(lower is better); fetch in rank order; the first covering >= %g of the hours wins; "
                 "else the best-covered if >= %g; else ERA5 reanalysis"
                 % (MAX_CANDIDATE_DISTANCE_KM, min_coverage, MIN_STATION_COVERAGE)),
        "weights": {"per_km": SCORE_PER_KM, "per_100m_elevation_difference": SCORE_PER_100M_ELEV,
                    "elevation_unknown": SCORE_ELEV_UNKNOWN, "summit_ridge": SCORE_SUMMIT,
                    "summit_min_above_site_m": SUMMIT_MIN_ABOVE_SITE_M, "raws": SCORE_RAWS_BONUS,
                    "evidence": "assumed (CrisisTwin choice, not a published constant)"},
        "warn_if": {"elevation_diff_m_over": WARN_ELEV_DIFF_M, "distance_km_over": WARN_DISTANCE_KM},
        "site": site,
        "states": list(states) if states is not None else "catalog given",
        "max_candidates": k,
        "forced": forced,
    }
    cands: list[dict] = [info for _, info in ranked]
    not_fetched = ("; not fetched: the request forced a source" if forced
                   else "; not fetched: a better-ranked station had enough data")
    for info in cands:
        info.update(status="not_tried", coverage=None, reason=_why(info) + not_fetched)
    if not ranked:
        warnings.append(f"No wind-capable station within {MAX_CANDIDATE_DISTANCE_KM:g} km has an archive "
                        "covering the start.")

    def fetch(st: Station, info: dict) -> Optional[WeatherSeries]:
        try:
            ser = fetch_history(st, start, end, http_get=http_get, cache_dir=cache_dir)
        except WeatherError as exc:
            info.update(status="error", error=str(exc), reason=_why(info) + f"; fetch failed: {exc}")
            return None
        cov = ser.coverage()
        info.update(status="tried", coverage=round(cov, 3),
                    reason=_why(info) + f"; wind in {cov:.0%} of the hours")
        return ser

    def reanalysis() -> Optional[WeatherSeries]:
        try:
            ser = fetch_reanalysis(lon, lat, start, end, http_get=http_get, cache_dir=cache_dir)
        except (WeatherError, ValueError, KeyError) as exc:
            selection["reanalysis_error"] = str(exc)
            return None
        if ser.coverage() == 0:
            return None
        w = qc_warning(ser.provenance.get("obs_qc"), "the ERA5 reanalysis")
        if w:
            warnings.append(w)
        return ser

    def finish_station(st, info, ser):
        info["status"] = "chosen"
        info["reason"] = info["reason"].replace(not_fetched, "")
        selection["chosen"] = {k2: info.get(k2) for k2 in (
            "id", "name", "source", "distance_km", "elevation_m", "elevation_diff_m", "exposure",
            "score", "score_terms", "rank", "coverage")}
        warnings.extend(station_warnings(info))
        w = qc_warning(ser.provenance.get("obs_qc"), f"{st.id} ({st.name}, {st.source})")
        if w:
            warnings.append(w)
        fill, fill_warnings = _fill_rh_gaps(ser, st, ranked, start, end, http_get=http_get, cache_dir=cache_dir)
        if fill is not None:
            ser.provenance["rh_gap_fill"] = fill
        warnings.extend(fill_warnings)
        return ser

    # Forced choice.
    if forced and forced.strip().lower() == REANALYSIS_ID:
        ser = reanalysis()
        if ser is None:
            raise WeatherError(f"reanalysis has no data for the window: {selection.get('reanalysis_error')}")
        selection["chosen"] = {"id": REANALYSIS_ID, "reason": "forced by the request"}
        warnings.append(ser.provenance["limits"])
        return ser, cands + excluded, selection, warnings
    if forced:
        st = _find_station(forced, lon, lat, catalog, http_get, cache_dir)
        info = next((i for s, i in ranked if s.id == st.id), None)
        if info is None:
            info = {"station": st.id, "id": st.id, "name": st.name, "source": st.source,
                    "network": st.network, "lon": st.lon, "lat": st.lat,
                    "distance_km": st.distance_km, "elevation_m": st.elevation_m,
                    "rank": None, **score_station(st, site["elevation_m"])}
            cands.append(info)
        ser = fetch(st, info)
        if ser is None or ser.coverage() == 0:
            raise WeatherError(f"{st.id} ({st.name}) has no wind observations for the window "
                               f"({info.get('error') or 'coverage 0'}); choose another station")
        info["reason"] += "; forced by the request"
        return finish_station(st, info, ser), cands + excluded, selection, warnings

    # Ranked choice.
    best = None  # (coverage, station, info, series); ties keep the better-ranked station
    for st, info in ranked:
        ser = fetch(st, info)
        if ser is None:
            continue
        cov = ser.coverage()
        if best is None or cov > best[0]:
            best = (cov, st, info, ser)
        if cov >= min_coverage:
            return finish_station(st, info, ser), cands + excluded, selection, warnings
    if best is not None and best[0] >= MIN_STATION_COVERAGE:
        warnings.append(f"No station covered {min_coverage:.0%} of the hours; using the best-covered "
                        f"({best[0]:.0%}).")
        return finish_station(best[1], best[2], best[3]), cands + excluded, selection, warnings
    ser = reanalysis()
    if ser is not None:
        selection["chosen"] = {"id": REANALYSIS_ID,
                               "reason": "no station within %g km had wind for >= %g of the hours"
                                         % (MAX_CANDIDATE_DISTANCE_KM, MIN_STATION_COVERAGE)}
        warnings.append("No representative station had data: hourly ERA5 reanalysis is used "
                        "(modelled, not observed). " + ser.provenance["limits"])
        return ser, cands + excluded, selection, warnings
    if best is not None and best[0] > 0:
        warnings.append(f"Reanalysis unavailable; using a station with only {best[0]:.0%} of the hours.")
        return finish_station(best[1], best[2], best[3]), cands + excluded, selection, warnings
    tried = [{"station": c["id"], "coverage": c.get("coverage"), "error": c.get("error")}
             for c in cands if c.get("status") != "not_tried"]
    raise WeatherError(
        f"no wind data near ({lon}, {lat}) for the window: stations tried {tried}; "
        f"reanalysis: {selection.get('reanalysis_error', 'no data')}"
    )


def scenario_wind(
    lon: float,
    lat: float,
    start,
    hours: int,
    mode: str,
    *,
    k: int = MAX_CANDIDATES,
    min_coverage: float = 0.75,
    percentile: float = 95.0,
    sector: tuple[float, float] = (315.0, 90.0),
    station: Optional[str] = None,
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
    catalog: Optional[Sequence[Station]] = None,
) -> dict:
    """Hourly weather for a scenario at ``(lon, lat)``, ``start`` (aware UTC), ``hours`` long.

    ``mode``:

    * ``historical_replay``: up to ``k`` wind-capable stations (ASOS and RAWS) within
      ``MAX_CANDIDATE_DISTANCE_KM`` are ranked by ``score_station`` (distance, elevation
      difference from the site, summit exposure, RAWS preference) and fetched in rank order;
      the first covering at least ``min_coverage`` of the hours wins, else the best-covered one
      if it covers ``MIN_STATION_COVERAGE``, else the hourly ERA5 reanalysis (evidence class
      ``modelled``). ``station`` forces a station id, or ``"reanalysis"``.
    * ``climatology_percentile``: see ``climatology_percentile`` (evidence class ``derived``).
    * ``forecast``: NWS gridpoint forecast (evidence class ``forecast``).

    Returns a JSON-serialisable dict: ``{mode, evidence_class, evidence_label, lon, lat,
    start_utc, hours, units, samples:[{t_utc, speed_ms, from_deg, gust_ms, rh_pct, temp_c, precip_mm,
    n_obs}], station, source, candidates, warnings, provenance, summary}``. Gaps are ``None``
    samples and are counted in ``summary``. ``candidates`` lists every ranked station with its
    score, terms, status (chosen / tried / not_tried / error / no_wind_sensor), coverage and
    reason, then the reanalysis option; ``provenance.station_selection`` has the rule, weights,
    site elevation and the chosen station.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if hours < 1:
        raise ValueError("hours must be >= 1")
    start = require_utc(start, "start")
    end = start + timedelta(hours=hours)
    candidates: list[dict] = []
    warnings: list[str] = []
    if mode == "forecast":
        series = fetch_forecast(lon, lat, start, hours, http_get=http_get)
        w = qc_warning(series.provenance.get("obs_qc"), "the NWS gridpoint forecast")
        if w:
            warnings.append(w)
    elif mode == "climatology_percentile":
        series = climatology_percentile(
            lon, lat, start, hours, percentile=percentile, sector=sector,
            catalog=catalog, http_get=http_get, cache_dir=cache_dir,
        )
        sel = series.provenance.get("station_selection") or {}
        candidates = sel.pop("candidates", [])
        warnings = sel.pop("warnings", [])
        st_id = (series.station or {}).get("id")
        w = qc_warning(series.provenance.get("obs_qc"), f"{st_id} (analog hours, times as observed)")
        if w:
            warnings.append(w)
    else:
        series, candidates, selection, warnings = _historical(
            lon, lat, start, end, k=k, min_coverage=min_coverage, forced=station,
            catalog=catalog, http_get=http_get, cache_dir=cache_dir,
        )
        option = _reanalysis_option(lon, lat)
        if series.source == "open_meteo_era5":
            option.update(status="chosen", reason=selection["chosen"].get("reason"))
        else:
            option.update(status="not_tried", reason="fallback when no station has data; "
                                                     "request it with station=reanalysis")
        candidates = candidates + [option]
        series.provenance["candidates"] = candidates
        series.provenance["station_selection"] = selection
    d = series.to_dict()
    samples = d["samples"]
    speeds = [s["speed_ms"] for s in samples if s["speed_ms"] is not None]
    summary = {
        "hours_requested": hours,
        "samples": len(samples),
        "missing_speed_samples": len(samples) - len(speeds),
        "max_speed_ms": max(speeds) if speeds else None,
        "max_gust_ms": max((s["gust_ms"] for s in samples if s["gust_ms"] is not None), default=None),
        "mean_speed_ms": (sum(speeds) / len(speeds)) if speeds else None,
    }
    return {
        "mode": mode,
        "evidence_class": series.evidence_class,
        "evidence_label": EVIDENCE_LABELS.get(series.evidence_class, series.evidence_class),
        "lon": lon,
        "lat": lat,
        "start_utc": iso_z(start),
        "hours": hours,
        "units": d["units"],
        "station": d["station"],
        "source": d["source"],
        "samples": samples,
        "candidates": candidates,
        "warnings": warnings,
        "provenance": d["provenance"],
        "summary": summary,
    }
