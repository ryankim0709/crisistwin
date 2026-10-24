"""Shared constants and helpers for the Kincade Fire (2019) evacuation package.

Only the Python standard library is used. Network access happens in the
acquisition scripts (curl, fixed endpoints); everything here is offline.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone

from tools.build_camp_evacuation import SourceError, encoded_json, sha256

__all__ = [
    "INCIDENT_ID", "INCIDENT_NUMBER", "BBOX", "SNAPSHOT_AT", "SourceError",
    "encoded_json", "sha256", "gzip_bytes", "gunzip_checked", "utc_text",
    "local_to_utc", "PDT", "PST", "valid_lon_lat", "walk_coords", "bbox_of",
]

INCIDENT_ID = "kincade-2019-evacuation"
# CAL FIRE DINS INCIDENTNUM and the Sonoma EOC layer name
# "Zone31_Kincade_CALNU019376" both give CA-LNU-019376.
INCIDENT_NUMBER = "CALNU 019376"
# West, south, east, north (OGC:CRS84). Covers every polygon of CAL FIRE
# evacuation-order zones 1-10 (union bbox -123.189, 38.256, -122.525, 38.851,
# from the Sonoma EOC layers) plus warning zones 21 and 31-34 and US 101
# detector locations; see quality.json for the measured extents.
BBOX = (-123.20, 38.25, -122.50, 38.92)
SNAPSHOT_AT = "2019-10-23T00:00:00Z"

# Daylight time ended 2019-11-03 02:00 local; the priority window is before it.
PDT = timezone(timedelta(hours=-7), "PDT")
PST = timezone(timedelta(hours=-8), "PST")
DST_END_UTC = datetime(2019, 11, 3, 9, 0, tzinfo=timezone.utc)
DST_START_UTC = datetime(2019, 3, 10, 10, 0, tzinfo=timezone.utc)


def gzip_bytes(data: bytes) -> bytes:
    """Deterministic gzip container (mtime 0) for bulky raw text sources."""
    return gzip.compress(data, compresslevel=9, mtime=0)


def gunzip_checked(data: bytes, expected_sha256: str, label: str) -> bytes:
    try:
        raw = gzip.decompress(data)
    except (OSError, EOFError) as exc:
        raise SourceError(f"{label}: invalid gzip container: {exc}") from exc
    if sha256(raw) != expected_sha256:
        raise SourceError(f"{label}: decompressed bytes do not match recorded source SHA-256")
    return raw


def utc_text(value: datetime) -> str:
    if value.tzinfo is None:
        raise SourceError("naive datetime cannot be converted to UTC")
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_to_utc(naive_local: datetime) -> datetime:
    """Convert a naive America/Los_Angeles wall time in 2019 to aware UTC.

    The ambiguous hour of 2019-11-03 01:00-02:00 is rejected rather than
    guessed; none of the packaged sources use it.
    """
    if naive_local.tzinfo is not None:
        raise SourceError("expected a naive local time")
    if naive_local.year != 2019:
        raise SourceError("local-time conversion is limited to 2019")
    if datetime(2019, 11, 3, 1, 0) <= naive_local < datetime(2019, 11, 3, 2, 0):
        raise SourceError(f"ambiguous local time during DST fall-back: {naive_local}")
    if datetime(2019, 3, 10, 2, 0) <= naive_local < datetime(2019, 3, 10, 3, 0):
        raise SourceError(f"nonexistent local time during DST spring-forward: {naive_local}")
    pdt = naive_local.replace(tzinfo=PDT)
    if DST_START_UTC <= pdt.astimezone(timezone.utc) < DST_END_UTC:
        return pdt.astimezone(timezone.utc)
    return naive_local.replace(tzinfo=PST).astimezone(timezone.utc)


def valid_lon_lat(coord: object) -> bool:
    return (isinstance(coord, (list, tuple)) and len(coord) >= 2
            and all(type(v) in (int, float) and math.isfinite(v) for v in coord[:2])
            and -180 <= coord[0] <= 180 and -90 <= coord[1] <= 90)


def walk_coords(coords: object):
    if isinstance(coords, (list, tuple)) and coords and type(coords[0]) in (int, float):
        yield coords
    elif isinstance(coords, (list, tuple)):
        for item in coords:
            yield from walk_coords(item)


def bbox_of(points) -> list[float]:
    pts = list(points)
    if not pts:
        raise SourceError("cannot compute bbox of empty geometry")
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]


def load_json(data: bytes, label: str):
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"{label}: invalid JSON: {exc}") from exc


def file_digest(data: bytes) -> dict:
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
