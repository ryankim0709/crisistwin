"""Write-back cache of finished landscape grids (gzip packages) in GridFS.

POST /api/landscapes/cache?key=<key>   body: the gzip package bytes from encodeLandscapePackage
GET  /api/landscapes/cache?key=<key>   200 gzip bytes, or 404

The key is chosen by the browser (app/src/fire/landscapeCache.ts: centre rounded, radius, cell
size, data version). The server checks the key shape, the gzip and package magic and a size cap,
stores the bytes in the GridFS bucket `landscape_cache` (one file per key, newest wins), and
keeps at most settings.LANDSCAPE_CACHE_MAX_FILES files (oldest evicted). These are cached copies of live LANDFIRE and terrain reads,
not the prebuilt regions in `landscape_packages`.

A store gets its own operation budget (STORE_TIMEOUT_S, pymongo.timeout) instead of the client's
15 s: GridFS counts the whole multi-MB upload as one operation, and from a slow uplink to Atlas
that never fit in 15 s, so nothing was ever cached. The browser posts fire and forget, so the
longer budget never delays a board.
"""

import hashlib
import json
import re
import zlib
from datetime import UTC, datetime

import gridfs
import pymongo
from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from gridfs.errors import GridFSError
from pymongo.errors import PyMongoError

from .mongodb import get_cache_database

BUCKET = "landscape_cache"
FILES = f"{BUCKET}.files"
KEY_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{7,127}")
MAGIC = b"CTLS1\n"
MAX_BYTES = 48 * 1024 * 1024
# ASSUMPTION: enough for a 48 MB package at about 0.5 MB/s up to Atlas.
STORE_TIMEOUT_S = 120
CACHE_CONTROL = "public, max-age=3600"


def _json(status: int, error: str) -> HttpResponse:
    return HttpResponse(
        ('{"error":"%s"}' % error).encode(),
        status=status,
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def _stream(stream):
    try:
        while chunk := stream.readchunk():
            yield chunk
    finally:
        stream.close()


def _is_package(data: bytes) -> bool:
    try:
        return zlib.decompressobj(31).decompress(data[:4096], len(MAGIC)) == MAGIC
    except zlib.error:
        return False


def _store(db, bucket, key: str, data: bytes) -> None:
    sha = hashlib.sha256(data).hexdigest()
    existing = db[FILES].find_one({"filename": key}, projection={"metadata.sha256": 1})
    if existing and (existing.get("metadata") or {}).get("sha256") == sha:
        return
    old_ids = [d["_id"] for d in db[FILES].find({"filename": key}, projection={"_id": 1})]
    bucket.upload_from_stream(
        key, data, metadata={"sha256": sha, "storedAt": datetime.now(UTC), "kind": "cached"}
    )
    for old in old_ids:
        bucket.delete(old)
    surplus = db[FILES].count_documents({}) - settings.LANDSCAPE_CACHE_MAX_FILES
    if surplus > 0:
        for doc in db[FILES].find({}, projection={"_id": 1}).sort("uploadDate", 1).limit(surplus):
            bucket.delete(doc["_id"])


@csrf_exempt
@require_http_methods(["GET", "HEAD", "POST"])
def landscape_cache(request):
    key = request.GET.get("key", "")
    if not KEY_PATTERN.fullmatch(key):
        return _json(400, "invalid_key")
    try:
        db = get_cache_database()
        bucket = gridfs.GridFSBucket(db, bucket_name=BUCKET)
        if request.method == "POST":
            declared = request.META.get("CONTENT_LENGTH", "")
            if not declared.isdigit() or int(declared) > MAX_BYTES:
                return _json(413, "too_large")
            data = request.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                return _json(413, "too_large")
            if not _is_package(data):
                return _json(400, "not_a_landscape_package")
            with pymongo.timeout(STORE_TIMEOUT_S):
                _store(db, bucket, key, data)
            return HttpResponse(status=204)
        doc = db[FILES].find_one({"filename": key}, sort=[("uploadDate", -1)])
        if doc is None:
            return _json(404, "not_found")
        sha = (doc.get("metadata") or {}).get("sha256") or str(doc["_id"])
        etag = f'"{sha}"'
        headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
        if request.headers.get("If-None-Match") == etag:
            return HttpResponse(status=304, headers=headers)
        if request.method == "HEAD":
            response = HttpResponse(content_type="application/gzip", headers=headers)
            response["Content-Length"] = str(doc["length"])
            return response
        stream = bucket.open_download_stream(doc["_id"])
        response = StreamingHttpResponse(_stream(stream), content_type="application/gzip", headers=headers)
        response["Content-Length"] = str(stream.length)
        return response
    except (PyMongoError, GridFSError, ValueError):
        return _json(503, "unavailable")


@require_http_methods(["GET"])
def landscape_cache_status(request):
    """GET /api/landscapes/cache/status?keys=k1,k2,...
    -> {"cached": {key: {"bytes", "storedAt"}}, "files": total files, "maxFiles": cap}.

    Metadata only (no grid bytes), so the UI can show which boards are already cached.
    At most 200 keys per call; unknown or malformed keys are simply absent from the result.
    """
    keys = [k for k in request.GET.get("keys", "").split(",") if KEY_PATTERN.fullmatch(k)][:200]
    found = {}
    total = 0
    try:
        db = get_cache_database()
        total = db[FILES].count_documents({})
        if keys:
            for doc in db[FILES].find(
                {"filename": {"$in": keys}}, projection={"filename": 1, "length": 1, "uploadDate": 1}
            ):
                found[doc["filename"]] = {
                    "bytes": doc["length"],
                    "storedAt": doc["uploadDate"].replace(tzinfo=UTC).isoformat(),
                }
    except (PyMongoError, ValueError):
        return _json(503, "unavailable")
    return HttpResponse(
        json.dumps({"cached": found, "files": total, "maxFiles": settings.LANDSCAPE_CACHE_MAX_FILES}),
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )
