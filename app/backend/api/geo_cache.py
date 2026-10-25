"""Read-through MongoDB cache for the three public geodata sources the board loads.

GET /api/geo/landfire/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=...&subset=X(a,b)&subset=Y(c,d)
GET /api/geo/terrarium/<z>/<x>/<y>.png        (AWS terrain tiles, terrarium encoding)
GET /api/geo/imagery/<z>/<y>/<x>              (USGS USGSImageryOnly tiles; y before x, as upstream)

Each is a fixed-upstream proxy, not an open one: GET only, a whitelist of query parameters and
coverage ids, numeric ranges checked, and the upstream host never taken from the request. The
response bytes are stored in the MongoDB collection `geo_cache`, keyed by a SHA-256 of the
normalised request, and served with a long Cache-Control. These sources are versioned or slow
moving (LANDFIRE LF2025, terrarium, USGS imagery), so entries are not expired; drop the
collection to refresh. A MongoDB failure only costs the cache: the request is still proxied.

LANDFIRE keeps the semantics of the Vite dev proxy (app/vite.config.ts): browser-only headers
are never forwarded, the request identifies itself as this application, only IPv4 is used, and
the last good address is reused while DNS lookups fail.
"""

import hashlib
import http.client
import logging
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime

from bson import Binary
from django.http import HttpResponse
from django.views.decorators.http import require_GET
from pymongo.errors import PyMongoError

from .mongodb import get_cache_database

logger = logging.getLogger(__name__)

COLLECTION = "geo_cache"
USER_AGENT = "CrisisTwin/0.1 (hackathon planning prototype)"
CACHE_CONTROL = "public, max-age=604800, immutable"
MAX_BODY_BYTES = {"landfire": 12 * 1024 * 1024, "terrarium": 1024 * 1024, "imagery": 2 * 1024 * 1024}
UPSTREAM_TIMEOUT_S = 40
ATTEMPTS = 3
RETRY_BASE_S = 0.5
MIN_COVERAGE_BYTES = 1024

LANDFIRE_HOST = "edcintl.cr.usgs.gov"
LANDFIRE_PATH = "/geoserver/landfire/wcs"
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
IMAGERY_URL = (
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
)
MAX_TERRARIUM_ZOOM = 15
MAX_IMAGERY_ZOOM = 17

COVERAGES = frozenset(
    {
        "landfire__LF2025_FBFM40_CONUS",
        "landfire__LF2025_CBH_CONUS",
        "landfire__LF2025_CBD_CONUS",
        "landfire__LF2025_CC_CONUS",
        "landfire__LF2025_CH_CONUS",
    }
)
NEAREST = "http://www.opengis.net/def/interpolation/OGC/1/nearest-neighbor"
NUMBER = r"-?\d{1,9}(?:\.\d{1,4})?"
SUBSET = re.compile(rf"^([XY])\(({NUMBER}),({NUMBER})\)$")
SCALESIZE = re.compile(r"^i\((\d{1,4})\),j\((\d{1,4})\)$")
# Mercator metres. 400 km is more than the 120 km a 60 km-radius board spans.
MAX_SUBSET_SPAN_M = 400_000
MAX_SCALESIZE = 2048
FIXED_PARAMS = {"service": "WCS", "version": "2.0.1", "request": "GetCoverage", "format": "image/tiff"}
ALLOWED_PARAMS = frozenset(FIXED_PARAMS) | {"coverageId", "subset", "scalesize", "interpolation"}


class Rejected(Exception):
    """The request is outside what this proxy forwards."""


# --- LANDFIRE connection: IPv4 only, last good address reused while DNS fails ---------------

_DNS_TTL_S = 300
_last_good: dict[str, tuple[list[str], float]] = {}
_dns_lock = threading.Lock()


def _resolve(host: str) -> list[str]:
    with _dns_lock:
        cached = _last_good.get(host)
    if cached and time.monotonic() - cached[1] < _DNS_TTL_S:
        return cached[0]
    try:
        infos = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(info[4][0] for info in infos))
        if addresses:
            with _dns_lock:
                _last_good[host] = (addresses, time.monotonic())
            return addresses
    except OSError:
        pass
    if cached:
        return cached[0]
    raise OSError(f"No IPv4 address for {host}")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connects to a resolved address but keeps the hostname for SNI and verification."""

    def connect(self):
        last_error: OSError | None = None
        for address in _resolve(self.host):
            try:
                sock = socket.create_connection((address, self.port), self.timeout)
            except OSError as error:
                last_error = error
                continue
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
            return
        raise last_error or OSError("connect failed")


def _landfire_get(path_and_query: str) -> tuple[int, bytes, str]:
    connection = _PinnedHTTPSConnection(
        LANDFIRE_HOST, 443, timeout=UPSTREAM_TIMEOUT_S, context=ssl.create_default_context()
    )
    try:
        connection.request(
            "GET",
            path_and_query,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "image/tiff,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Encoding": "identity",
            },
        )
        response = connection.getresponse()
        body = response.read(MAX_BODY_BYTES["landfire"] + 1)
        return response.status, body, response.getheader("Content-Type") or ""
    finally:
        connection.close()


def _plain_get(url: str, limit: int) -> tuple[int, bytes, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
            return response.status, response.read(limit + 1), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        return error.code, b"", ""


# --- cache and retry -------------------------------------------------------------------------


def _fetch_with_retry(kind: str, fetch, accept) -> tuple[int, bytes, str]:
    """Run `fetch` up to ATTEMPTS times on network errors, 5xx and 429. Returns (status, body, type)."""
    status = 0
    for attempt in range(ATTEMPTS):
        try:
            status, body, content_type = fetch()
            if status == 200:
                if len(body) > MAX_BODY_BYTES[kind]:
                    return 502, b"", ""
                if accept(body):
                    return 200, body, content_type
            elif status < 500 and status != 429:
                return status, b"", ""
        except (OSError, http.client.HTTPException):
            status = 0
        if attempt < ATTEMPTS - 1:
            time.sleep(RETRY_BASE_S * 2**attempt)
    return (status if status else 504), b"", ""


def _error(status: int, code: str) -> HttpResponse:
    return HttpResponse(
        ('{"error":"%s"}' % code).encode(),
        status=status,
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def _binary(body: bytes, content_type: str, etag: str, state: str) -> HttpResponse:
    return HttpResponse(
        body,
        content_type=content_type,
        headers={"ETag": etag, "Cache-Control": CACHE_CONTROL, "X-Geo-Cache": state},
    )


def _serve(request, kind: str, key: str, fetch, accept, default_type: str) -> HttpResponse:
    etag = f'"{key[:32]}"'
    if request.headers.get("If-None-Match") == etag:
        return HttpResponse(status=304, headers={"ETag": etag, "Cache-Control": CACHE_CONTROL})
    collection = None
    try:
        collection = get_cache_database()[COLLECTION]
        doc = collection.find_one({"_id": key}, projection={"body": 1, "contentType": 1})
        if doc is not None:
            return _binary(bytes(doc["body"]), doc.get("contentType") or default_type, etag, "HIT")
    except (PyMongoError, ValueError):
        collection = None
    status, body, content_type = _fetch_with_retry(kind, fetch, accept)
    if status != 200:
        return _error(404, "not_found") if status == 404 else _error(502, f"upstream_{status}")
    content_type = content_type.split(";")[0].strip() or default_type
    if collection is not None:
        try:
            collection.replace_one(
                {"_id": key},
                {
                    "_id": key,
                    "kind": kind,
                    "body": Binary(body),
                    "contentType": content_type,
                    "length": len(body),
                    "fetchedAt": datetime.now(UTC),
                },
                upsert=True,
            )
        except (PyMongoError, ValueError):
            logger.warning("geo cache write failed", exc_info=True)
    return _binary(body, content_type, etag, "MISS")


def _bad_request(detail: str) -> HttpResponse:
    return HttpResponse(
        ('{"error":"invalid_request","detail":"%s"}' % detail).encode(),
        status=400,
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def _key(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


# --- LANDFIRE WCS ----------------------------------------------------------------------------


def _normalise_wcs(query) -> str:
    """Canonical upstream query string from a request QueryDict, or raise Rejected."""
    for name in query:
        if name not in ALLOWED_PARAMS:
            raise Rejected(f"parameter {name} is not allowed")
    for name, expected in FIXED_PARAMS.items():
        if query.getlist(name) != [expected]:
            raise Rejected(f"{name} must be {expected}")
    coverage = query.getlist("coverageId")
    if len(coverage) != 1 or coverage[0] not in COVERAGES:
        raise Rejected("unknown coverageId")
    subsets: dict[str, tuple[str, str]] = {}
    for value in query.getlist("subset"):
        match = SUBSET.match(value)
        if not match or match.group(1) in subsets:
            raise Rejected("subset must be X(min,max) and Y(min,max)")
        low, high = float(match.group(2)), float(match.group(3))
        if not (high > low and high - low <= MAX_SUBSET_SPAN_M) or max(abs(low), abs(high)) > 21_000_000:
            raise Rejected("subset out of range")
        subsets[match.group(1)] = (match.group(2), match.group(3))
    if set(subsets) != {"X", "Y"}:
        raise Rejected("subset X and Y are required")
    parts = [
        "service=WCS",
        "version=2.0.1",
        "request=GetCoverage",
        f"coverageId={coverage[0]}",
        f"subset=X({subsets['X'][0]},{subsets['X'][1]})",
        f"subset=Y({subsets['Y'][0]},{subsets['Y'][1]})",
    ]
    scalesize = query.get("scalesize")
    interpolation = query.get("interpolation")
    if scalesize is not None or interpolation is not None:
        match = SCALESIZE.match(scalesize or "")
        if not match or interpolation != NEAREST:
            raise Rejected("scalesize needs i(n),j(n) and nearest-neighbor interpolation")
        if not all(1 <= int(g) <= MAX_SCALESIZE for g in match.groups()):
            raise Rejected("scalesize out of range")
        parts += [f"scalesize={scalesize}", f"interpolation={NEAREST}"]
    parts.append("format=image/tiff")
    return "&".join(parts)


def _is_tiff(body: bytes) -> bool:
    return len(body) >= MIN_COVERAGE_BYTES and body[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")


@require_GET
def landfire_wcs(request):
    try:
        canonical = _normalise_wcs(request.GET)
    except Rejected as error:
        return _bad_request(str(error))
    upstream = f"{LANDFIRE_PATH}?{canonical}"
    return _serve(
        request,
        "landfire",
        _key("landfire", canonical),
        lambda: _landfire_get(upstream),
        _is_tiff,
        "image/tiff",
    )


# --- tiles -----------------------------------------------------------------------------------


def _tile_in_range(z: int, x: int, y: int, max_zoom: int) -> bool:
    return 0 <= z <= max_zoom and 0 <= x < 2**z and 0 <= y < 2**z


def _is_png(body: bytes) -> bool:
    return body[:8] == b"\x89PNG\r\n\x1a\n"


def _is_image(body: bytes) -> bool:
    return body[:3] == b"\xff\xd8\xff" or _is_png(body)


@require_GET
def terrarium_tile(request, z: str, x: str, y: str):
    zi, xi, yi = int(z), int(x), int(y)
    if not _tile_in_range(zi, xi, yi, MAX_TERRARIUM_ZOOM):
        return _bad_request("tile out of range")
    url = TERRARIUM_URL.format(z=zi, x=xi, y=yi)
    return _serve(
        request,
        "terrarium",
        _key("terrarium", f"{zi}/{xi}/{yi}"),
        lambda: _plain_get(url, MAX_BODY_BYTES["terrarium"]),
        _is_png,
        "image/png",
    )


@require_GET
def imagery_tile(request, z: str, y: str, x: str):
    zi, xi, yi = int(z), int(x), int(y)
    if not _tile_in_range(zi, xi, yi, MAX_IMAGERY_ZOOM):
        return _bad_request("tile out of range")
    url = IMAGERY_URL.format(z=zi, x=xi, y=yi)
    return _serve(
        request,
        "imagery",
        _key("imagery", f"{zi}/{yi}/{xi}"),
        lambda: _plain_get(url, MAX_BODY_BYTES["imagery"]),
        _is_image,
        "image/jpeg",
    )
