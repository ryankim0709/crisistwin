"""NASA FIRMS adapter: satellite thermal anomalies over an area of interest.

A FIRMS record is an **observation of heat** in one satellite pixel. It is not a
fire perimeter, not a fire size, and not a road closure: a hot pixel may be a
wildfire, a prescribed burn, a gas flare, or an industrial roof, and the absence
of pixels is not evidence that nothing is burning, because cloud, thick smoke,
and gaps between overpasses all hide fire. Records leave this module as
``Evidence(kind="observation")`` and must never be widened into a mapped
perimeter downstream.

The API facts below were checked against the live FIRMS documentation on
2026-10-23 (https://firms.modaps.eosdis.nasa.gov/api/area/):

- ``/api/area/csv/[MAP_KEY]/[SOURCE]/[west,south,east,north]/[DAY_RANGE]/[DATE]``
- ``AREA_COORDINATES`` are WGS84 decimal degrees in ``west,south,east,north``
  order - longitude first, unlike every other coordinate pair in this package.
- ``DAY_RANGE`` is ``1..5`` days. ``DATE`` (``YYYY-MM-DD``) is the *start* of the
  window and the window runs forward: ``[DATE .. DATE + DAY_RANGE - 1]``.
- CSV columns are ``latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,
  satellite,instrument,confidence,version,bright_ti5,frp,daynight`` for VIIRS,
  and the same list with ``brightness``/``bright_t31`` for MODIS.
- ``acq_time`` is UTC ``HHMM`` and is **not** zero padded (``631`` is 06:31).
- ``brightness`` / ``bright_ti4`` are Kelvin and ``frp`` is megawatts; both are
  carried through exactly as published.
- One MAP_KEY is limited to 5000 transactions per 10-minute interval.

The MAP_KEY is a credential. It is read from ``FIRMS_MAP_KEY``, is never logged,
and is replaced by :data:`REDACTED_MAP_KEY` in every ``Evidence.source_url`` and
every error message this module produces.
"""

from __future__ import annotations

import csv
import io
import math
import os
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import date, datetime, timezone

from ..domain import (
    EARTH_RADIUS_METERS,
    AreaOfInterest,
    DetectionConfidence,
    Evidence,
    FireDetection,
    GeoPoint,
    utc_now,
)
from ..ports import PortUnavailableError

FIRMS_AREA_CSV_ROOT = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
FIRMS_MAP_KEY_ENV_VAR = "FIRMS_MAP_KEY"
REDACTED_MAP_KEY = "MAP_KEY-REDACTED"

#: The area API accepts 1..5 days of data per request.
MAX_DAY_RANGE_DAYS = 5

#: Two VIIRS 375 m near-real-time feeds: finer than MODIS and the most useful
#: pair for a town-scale watch. Both are queried and their detections kept
#: separately - two satellites seeing the same fire are two observations.
DEFAULT_FIRMS_SOURCES: tuple[str, ...] = ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT")

#: Sources whose CSV schema this adapter implements. FIRMS also serves
#: ``LANDSAT_NRT``, which publishes different columns and a different confidence
#: vocabulary, so it is rejected here rather than parsed incorrectly.
SUPPORTED_FIRMS_SOURCES: frozenset[str] = frozenset(
    {
        "MODIS_NRT",
        "MODIS_SP",
        "VIIRS_SNPP_NRT",
        "VIIRS_SNPP_SP",
        "VIIRS_NOAA20_NRT",
        "VIIRS_NOAA20_SP",
        "VIIRS_NOAA21_NRT",
        "VIIRS_NOAA21_SP",
    }
)

# FIRMS publishes confidence in two vocabularies and this adapter maps both onto
# the three domain classes.
#
# VIIRS (375 m I-band) publishes the class itself as l / n / h, so it is taken as
# published and no threshold of ours is involved.
#
# MODIS publishes a 0-100% confidence estimate instead. The cut points below are
# the ones NASA documents for binning that estimate into the same three classes
# (MODIS C6/C6.1 Active Fire User's Guide, and the FIRMS FAQ):
#   low      0 <= c < 30
#   nominal 30 <= c < 80
#   high    80 <= c <= 100
MODIS_NOMINAL_CONFIDENCE_PERCENT = 30.0
MODIS_HIGH_CONFIDENCE_PERCENT = 80.0

_LETTER_CONFIDENCE: dict[str, DetectionConfidence] = {
    "l": "low",
    "low": "low",
    "n": "nominal",
    "nominal": "nominal",
    "h": "high",
    "high": "high",
}

_REQUIRED_COLUMNS = frozenset({"latitude", "longitude", "acq_date", "acq_time", "confidence"})

#: Near the poles a longitude degree collapses; floor the cosine so the bounding
#: box stays finite instead of dividing by ~0.
_MIN_COS_LATITUDE = 1e-6

_USER_AGENT = "CrisisTwin/0.1 (hackathon research prototype)"

_EVIDENCE_NOTE = (
    "Satellite thermal anomaly (hot pixel) as published by NASA FIRMS. "
    "An observation of heat, not a fire perimeter and not a road closure."
)


class FirmsDetectionSource:
    """Live :class:`~crisistwin_agent.ports.DetectionSource` backed by NASA FIRMS.

    Raises :class:`PortUnavailableError` for a missing MAP_KEY, a network
    failure, a non-200 response, or a body that is not FIRMS CSV. It never
    returns ``[]`` for any of those: an empty list means FIRMS answered and had
    no hot pixels in the area, which is a real finding.
    """

    source_id: str = "nasa-firms"

    def __init__(
        self,
        sources: Sequence[str] = DEFAULT_FIRMS_SOURCES,
        *,
        map_key: str | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        requested = tuple(sources)
        if not requested:
            raise ValueError("at least one FIRMS source is required")
        unsupported = [s for s in requested if s not in SUPPORTED_FIRMS_SOURCES]
        if unsupported:
            raise ValueError(f"unsupported FIRMS sources {unsupported}; supported: {sorted(SUPPORTED_FIRMS_SOURCES)}")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.sources: tuple[str, ...] = requested
        self.timeout_seconds = timeout_seconds
        self._map_key = map_key

    def fetch(self, area: AreaOfInterest, since: datetime) -> list[FireDetection]:
        """Hot pixels inside ``area`` acquired at or after ``since`` (UTC).

        The API takes a bounding box, so the request covers a square around the
        circular area; the response is filtered back down with ``area.contains``.
        """
        if since.tzinfo is None:
            raise ValueError("since must be timezone-aware UTC")
        since_utc = since.astimezone(timezone.utc)
        map_key = self._resolve_map_key()
        retrieved_at = utc_now()
        day_range, start_date = self._window(since_utc, retrieved_at)
        bbox = self._bounding_box(area)

        detections: list[FireDetection] = []
        for source in self.sources:
            url = f"{FIRMS_AREA_CSV_ROOT}/{map_key}/{source}/{bbox}/{day_range}/{start_date.isoformat()}"
            display_url = _redact(url, map_key)
            body = self._read(url, map_key, display_url)
            evidence = Evidence(
                kind="observation",
                source_id=f"{self.source_id}:{source.lower()}",
                source_name=f"NASA FIRMS {source}",
                retrieved_at=retrieved_at,
                source_url=display_url,
                note=_EVIDENCE_NOTE,
            )
            detections.extend(self._parse_csv(body, source, evidence))

        inside = [d for d in detections if d.detected_at >= since_utc and area.contains(d.location)]
        inside.sort(key=lambda d: (d.detected_at, d.location.latitude, d.location.longitude))
        return inside

    def _resolve_map_key(self) -> str:
        map_key = (self._map_key or os.environ.get(FIRMS_MAP_KEY_ENV_VAR, "")).strip()
        if not map_key:
            raise PortUnavailableError(
                self.source_id,
                f"no MAP_KEY configured; set {FIRMS_MAP_KEY_ENV_VAR} "
                "(free key: https://firms.modaps.eosdis.nasa.gov/api/map_key/)",
            )
        return map_key

    def _window(self, since: datetime, now: datetime) -> tuple[int, date]:
        """Translate ``[since, now]`` into the API's ``(DAY_RANGE, DATE)`` pair.

        Whole UTC days, inclusive of both ends, because that is the granularity
        FIRMS offers; rows older than ``since`` are filtered out afterwards.
        """
        start_date = since.date()
        span_days = (now.date() - start_date).days + 1
        if span_days < 1:
            raise ValueError("since is in the future; nothing can have been observed yet")
        if span_days > MAX_DAY_RANGE_DAYS:
            raise PortUnavailableError(
                self.source_id,
                f"the area API serves at most {MAX_DAY_RANGE_DAYS} days per request, "
                f"but since={since.isoformat()} asks for {span_days} days of history",
            )
        return span_days, start_date

    def _bounding_box(self, area: AreaOfInterest) -> str:
        """``west,south,east,north`` square that encloses the circular area."""
        lat_delta = math.degrees(area.radius_meters / EARTH_RADIUS_METERS)
        south = max(-90.0, area.center.latitude - lat_delta)
        north = min(90.0, area.center.latitude + lat_delta)
        # A longitude degree shortens away from the equator, so widen using the
        # box edge furthest from it; the square then never cuts into the circle.
        cos_latitude = max(math.cos(math.radians(max(abs(south), abs(north)))), _MIN_COS_LATITUDE)
        lon_delta = min(lat_delta / cos_latitude, 180.0)
        west = area.center.longitude - lon_delta
        east = area.center.longitude + lon_delta
        if west < -180.0 or east > 180.0:
            raise PortUnavailableError(
                self.source_id,
                f"area '{area.name}' crosses the antimeridian; a single FIRMS bounding box cannot express it",
            )
        return f"{west:.6f},{south:.6f},{east:.6f},{north:.6f}"

    def _read(self, url: str, map_key: str, display_url: str) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
                status = getattr(response, "status", 200)
                if status != 200:
                    raise PortUnavailableError(self.source_id, f"{display_url} returned HTTP {status}")
                payload = response.read()
        except urllib.error.HTTPError as error:
            raise PortUnavailableError(self.source_id, f"{display_url} returned HTTP {error.code}") from error
        except urllib.error.URLError as error:
            reason = _redact(str(error.reason), map_key)
            raise PortUnavailableError(self.source_id, f"could not reach {display_url}: {reason}") from error
        except TimeoutError as error:
            raise PortUnavailableError(
                self.source_id, f"{display_url} timed out after {self.timeout_seconds:g}s"
            ) from error
        except OSError as error:
            raise PortUnavailableError(
                self.source_id, f"could not reach {display_url}: {_redact(str(error), map_key)}"
            ) from error
        return payload.decode("utf-8", errors="replace")

    def _parse_csv(self, body: str, source: str, evidence: Evidence) -> list[FireDetection]:
        """Parse one FIRMS CSV response. A malformed row fails the whole fetch.

        A bad row is not dropped quietly: a partially parsed feed would look like
        a shorter list of fires, which is exactly the kind of quiet wrong answer
        the agent must not report.
        """
        reader = csv.DictReader(io.StringIO(body))
        headers = {(name or "").strip().lower() for name in (reader.fieldnames or [])}
        missing = sorted(_REQUIRED_COLUMNS - headers)
        if missing:
            raise PortUnavailableError(
                self.source_id,
                f"{source} response is not FIRMS CSV (missing columns {missing}); body starts: {_snippet(body)}",
            )

        detections: list[FireDetection] = []
        for line_number, raw_row in enumerate(reader, start=2):
            row = {
                key.strip().lower(): (value or "").strip() for key, value in raw_row.items() if isinstance(key, str)
            }
            if not any(row.values()):
                continue  # trailing blank line
            where = f"{source} row {line_number}"
            detected_at = _parse_detected_at(row.get("acq_date", ""), row.get("acq_time", ""), where, self.source_id)
            location = _parse_location(row.get("latitude", ""), row.get("longitude", ""), where, self.source_id)
            # Published values are carried through unconverted; a blank means
            # "not reported", which is None and never 0.
            brightness = _parse_optional_float(
                row.get("bright_ti4") or row.get("brightness"), "brightness", where, self.source_id
            )
            frp = _parse_optional_float(row.get("frp"), "frp", where, self.source_id)
            detections.append(
                FireDetection(
                    detected_at=detected_at,
                    location=location,
                    satellite=row.get("satellite") or source,
                    instrument=row.get("instrument") or source.split("_")[0],
                    confidence=_parse_confidence(row.get("confidence", ""), source, where, self.source_id),
                    brightness_kelvin=brightness,
                    frp_megawatts=frp,
                    evidence=evidence,
                    # FIRMS publishes no stable record id, so this one is
                    # synthesised from the fields that identify the pixel.
                    external_id=(
                        f"{source}:{detected_at:%Y%m%dT%H%MZ}:{location.latitude:.5f},{location.longitude:.5f}"
                    ),
                )
            )
        return detections


def _parse_detected_at(acq_date: str, acq_time: str, where: str, source_id: str) -> datetime:
    """``acq_date`` (YYYY-MM-DD) plus ``acq_time`` (UTC HHMM) to an aware UTC datetime.

    FIRMS does not zero-pad ``acq_time``: ``631`` is 06:31 and ``5`` is 00:05.
    """
    digits = acq_time.replace(":", "").strip()
    if not digits.isdigit() or len(digits) > 4:
        raise PortUnavailableError(source_id, f"{where}: unparseable acq_time {acq_time!r}")
    try:
        parsed = datetime.strptime(f"{acq_date.strip()} {digits.zfill(4)}", "%Y-%m-%d %H%M")
    except ValueError as error:
        raise PortUnavailableError(
            source_id, f"{where}: unparseable acquisition time {acq_date!r} {acq_time!r}"
        ) from error
    return parsed.replace(tzinfo=timezone.utc)


def _parse_location(latitude: str, longitude: str, where: str, source_id: str) -> GeoPoint:
    try:
        return GeoPoint(latitude=float(latitude), longitude=float(longitude))
    except ValueError as error:
        raise PortUnavailableError(source_id, f"{where}: unusable coordinates ({latitude!r}, {longitude!r})") from error


def _parse_optional_float(value: str | None, field_name: str, where: str, source_id: str) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        return float(value)
    except ValueError as error:
        raise PortUnavailableError(source_id, f"{where}: unparseable {field_name} {value!r}") from error


def _parse_confidence(raw: str, source: str, where: str, source_id: str) -> DetectionConfidence:
    """Map the VIIRS letter classes and the MODIS 0-100% estimate onto one scale."""
    value = raw.strip().lower()
    letter = _LETTER_CONFIDENCE.get(value)
    if letter is not None:
        return letter
    if source.startswith("VIIRS"):
        # VIIRS CSV carries l/n/h. A number here is a different encoding (the
        # vector product codes 7/8/9) and reading it with the MODIS percent
        # thresholds would silently downgrade every detection to "low".
        raise PortUnavailableError(source_id, f"{where}: expected a VIIRS l/n/h confidence, got {raw!r}")
    try:
        percent = float(value)
    except ValueError as error:
        raise PortUnavailableError(source_id, f"{where}: unparseable confidence {raw!r}") from error
    if percent < MODIS_NOMINAL_CONFIDENCE_PERCENT:
        return "low"
    if percent < MODIS_HIGH_CONFIDENCE_PERCENT:
        return "nominal"
    return "high"


def _redact(text: str, map_key: str) -> str:
    """Remove the MAP_KEY from anything that may be stored, shown, or logged."""
    return text.replace(map_key, REDACTED_MAP_KEY) if map_key else text


def _snippet(body: str, limit: int = 160) -> str:
    """A short single-line excerpt of a response body, for an error message.

    The MAP_KEY travels in the path and never in the body, so an excerpt cannot
    leak it; it is still clipped so the error stays readable.
    """
    flattened = " ".join(body.split())
    return flattened[:limit] + ("..." if len(flattened) > limit else "")
