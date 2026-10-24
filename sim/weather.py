"""Scenario weather: historical, climatological and forecast wind for any California point.

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
* Heights are not converted. ASOS and gridpoint winds are 10 m, RAWS winds are 20 ft
  (6.1 m); the Rothermel input is the open 20 ft wind (same simplification as
  ``app/src/fire/weather.ts``).
* Every series carries an evidence class: ``observed`` (station data), ``forecast`` (NWS
  gridpoint forecast) or ``derived`` (chosen statistically from observations, see
  ``climatology_percentile``).
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
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

OBSERVED = "observed"
FORECAST = "forecast"
DERIVED = "derived"

MODES = ("historical_replay", "climatology_percentile", "forecast")

KNOT_MS = 1852.0 / 3600.0  # exact: 1 knot = 1852 m / 3600 s
MPH_MS = 1609.344 / 3600.0  # exact: international mile
KMH_MS = 1000.0 / 3600.0

USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)"
IEM_ASOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
IEM_HADS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py"
IEM_NETWORK_URL = "https://mesonet.agron.iastate.edu/geojson/network/{network}.geojson"
NWS_POINTS_URL = "https://api.weather.gov/points/{lat:.4f},{lon:.4f}"

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
}

# SHEF physical-element codes used by the IEM HADS archive (English units).
HADS_WIND_SPEED = "USIRGZ"  # mph, sustained
HADS_WIND_DIR = "UDIRGZ"  # degrees true, from
HADS_WIND_PEAK = "UPHRGZ"  # mph, peak (gust)
HADS_TEMP = "TAIRGZ"  # deg F
HADS_RH = "XRIRGZ"  # percent


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

    def active_at(self, t: datetime) -> bool:
        day = t.astimezone(timezone.utc).strftime("%Y-%m-%d")
        if self.archive_begin and day < self.archive_begin:
            return False
        if self.archive_end and day > self.archive_end:
            return False
        return True


def parse_station_geojson(text: str, network: str) -> list[Station]:
    """Parse an IEM ``/geojson/network/<NET>.geojson`` document into stations.

    ``CA_ASOS`` -> ASOS/AWOS airports (wind reported). ``CA_DCP`` mixes hydrologic gauges
    (no wind) with RAWS; only stations whose name contains "RAWS" are kept. Whether a RAWS
    actually has wind for a given window is only known from its data, so callers must check
    coverage (``scenario_wind`` does).
    """
    source = {"CA_ASOS": "iem_asos", "CA_DCP": "iem_hads"}.get(network)
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
    cached IEM catalog (fetched once, then served from the disk cache).
    """
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError("coordinates are (lon, lat) in degrees")
    if k < 1:
        raise ValueError("k must be >= 1")
    stations = list(catalog) if catalog is not None else load_catalog(http_get, cache_dir)
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


def load_catalog(
    http_get: Optional[Callable] = None, cache_dir: Optional[Path] = None
) -> list[Station]:
    stations: list[Station] = []
    for network in ("CA_ASOS", "CA_DCP"):
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


def parse_asos_csv(text: str) -> list[RawObs]:
    """IEM asos.py ``format=onlycomma`` with ``tz=Etc/UTC``; speeds in knots, temp deg F."""
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
            )
        )
    out.sort(key=lambda o: o.t)
    return out


def parse_hads_csv(text: str) -> list[RawObs]:
    """IEM hads.py CSV (``what=txt``): SHEF columns in English units (mph, deg F).

    Several SHEF codes arrive on separate rows with different minutes; only rows carrying a
    wind speed or direction become observations.
    """
    rows = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    out: list[RawObs] = []
    for r in csv.DictReader(rows):
        if "utc_valid" not in r:
            raise WeatherError("HADS CSV missing 'utc_valid' column")
        spd, dr = _num(r.get(HADS_WIND_SPEED)), _num(r.get(HADS_WIND_DIR))
        if spd is None and dr is None:
            continue
        t = datetime.strptime(r["utc_valid"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
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
            )
        )
    out.sort(key=lambda o: o.t)
    return out


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
                n_obs=len(group),
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
    samples = hourly_series(obs, start, end)
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
    samples = parse_gridpoint(doc, start, hours)
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
    cands = nearest_stations(
        lon, lat, 1, catalog=catalog, sources=["iem_asos"],
        at=datetime(y0, 1, 1, tzinfo=timezone.utc), http_get=http_get, cache_dir=cache_dir,
    )
    if not cands:
        raise WeatherError("no ASOS station with an archive covering the climatology window")
    st = cands[0]
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
        pool.append((year, series.samples, series.provenance["raw"]))
        n_month = int((m1 - m0).total_seconds() // 3600)
        for first, n, peak in find_episodes(series.samples[:n_month], sector):
            all_eps.append((yi, first, n, peak))
    if not all_eps:
        raise WeatherError("no offshore-wind episodes in the climatology window")
    peaks = [e[3] for e in all_eps]
    target = percentile_nearest_rank(peaks, percentile)
    yi, first, n, peak = min((e for e in all_eps if e[3] == target), key=lambda e: (e[0], e[1]))
    year, samples, _ = pool[yi]
    window = samples[first : first + hours + 1]
    t0 = require_utc(window[0].t_utc, "analog")
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
            "raw": raw_records,
        },
    )


# --------------------------------------------------------------------------- scenario_wind


def scenario_wind(
    lon: float,
    lat: float,
    start,
    hours: int,
    mode: str,
    *,
    k: int = 4,
    min_coverage: float = 0.75,
    percentile: float = 95.0,
    sector: tuple[float, float] = (315.0, 90.0),
    http_get: Optional[Callable] = None,
    cache_dir: Optional[Path] = None,
    catalog: Optional[Sequence[Station]] = None,
) -> dict:
    """Hourly weather for a scenario at ``(lon, lat)``, ``start`` (aware UTC), ``hours`` long.

    ``mode``:

    * ``historical_replay``: observed hours from the nearest of the ``k`` nearest stations
      (ASOS and RAWS) that covers at least ``min_coverage`` of the window; if none does, the
      best-covered one. Every candidate and its coverage is listed in ``provenance``.
    * ``climatology_percentile``: see ``climatology_percentile`` (evidence class ``derived``).
    * ``forecast``: NWS gridpoint forecast (evidence class ``forecast``).

    Returns a JSON-serialisable dict: ``{mode, evidence_class, lon, lat, start_utc, hours,
    units, samples:[{t_utc, speed_ms, from_deg, gust_ms, rh_pct, temp_c, n_obs}], station,
    provenance, summary}``. Gaps are ``None`` samples and are counted in ``summary``.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if hours < 1:
        raise ValueError("hours must be >= 1")
    start = require_utc(start, "start")
    end = start + timedelta(hours=hours)
    if mode == "forecast":
        series = fetch_forecast(lon, lat, start, hours, http_get=http_get)
    elif mode == "climatology_percentile":
        series = climatology_percentile(
            lon, lat, start, hours, percentile=percentile, sector=sector,
            catalog=catalog, http_get=http_get, cache_dir=cache_dir,
        )
    else:
        cands = nearest_stations(
            lon, lat, k, catalog=catalog, at=start, http_get=http_get, cache_dir=cache_dir
        )
        if not cands:
            raise WeatherError("no station archive covers the requested start time")
        considered, best = [], None  # best = (coverage, series)
        for st in cands:
            try:
                cand = fetch_history(st, start, end, http_get=http_get, cache_dir=cache_dir)
            except WeatherError as exc:
                considered.append({"station": st.id, "distance_km": st.distance_km, "error": str(exc)})
                continue
            cov = cand.coverage()
            considered.append({"station": st.id, "distance_km": st.distance_km, "coverage": round(cov, 3)})
            if best is None or cov > best[0]:
                best = (cov, cand)
            if cov >= min_coverage:
                best = (cov, cand)  # nearest adequate station wins
                break
        if best is None or best[0] == 0:
            raise WeatherError(f"no wind observations near ({lon}, {lat}) for the window; tried {considered}")
        series = best[1]
        series.provenance["candidates"] = considered
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
        "lon": lon,
        "lat": lat,
        "start_utc": iso_z(start),
        "hours": hours,
        "units": d["units"],
        "station": d["station"],
        "source": d["source"],
        "samples": samples,
        "provenance": d["provenance"],
        "summary": summary,
    }
