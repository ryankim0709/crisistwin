"""Read-only API over prebuilt landscape packages stored in MongoDB GridFS (ADR 0013).

The offline builder owns writes. This module only reads: it lists the newest package per
region and streams one package's gzip bytes. It never creates indexes (see the README for
the recommended one) and never echoes driver errors.
"""

import re
from datetime import datetime
from typing import Any

import gridfs
from django.http import HttpResponse, StreamingHttpResponse
from gridfs.errors import GridFSError
from pymongo.errors import PyMongoError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .mongodb import get_database

BUCKET = "landscape_packages"
FILES_COLLECTION = f"{BUCKET}.files"
REGION_ID_PATTERN = re.compile(r"[a-z0-9-]{1,64}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
MAX_REGIONS = 100
CACHE_CONTROL = "public, max-age=3600"

# Optional catalogue fields the builder may copy into metadata; absent ones are omitted.
CATALOGUE_FIELDS = ("name", "counties", "summary", "center", "radiusMeters")
LATTICE_FIELDS = ("width", "height", "cellMeters")

_UNAVAILABLE = {"error": "unavailable"}
_NOT_FOUND = {"error": "not_found"}


def _iso(value: Any) -> Any:
    return value.isoformat().replace("+00:00", "Z") if isinstance(value, datetime) else value


def _region_summary(doc: dict[str, Any]) -> dict[str, Any] | None:
    meta = doc.get("metadata") or {}
    sha = doc.get("filename")
    if not isinstance(meta.get("regionId"), str) or not isinstance(sha, str):
        return None
    lattice = meta.get("lattice") if isinstance(meta.get("lattice"), dict) else {}
    out: dict[str, Any] = {"id": meta["regionId"]}
    for key in CATALOGUE_FIELDS:
        if key in meta:
            out[key] = meta[key]
    for key in LATTICE_FIELDS:
        value = lattice.get(key, meta.get(key))
        if value is not None:
            out[key] = value
    out["builtAt"] = _iso(meta.get("builtAt"))
    out["bytes"] = meta.get("bytes", doc.get("length"))
    out["sha256"] = sha
    return out


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def landscape_list(request):
    """Newest stored package per region."""
    pipeline = [
        {"$match": {"metadata.regionId": {"$type": "string"}}},
        {"$sort": {"metadata.builtAt": -1, "uploadDate": -1}},
        {"$group": {"_id": "$metadata.regionId", "doc": {"$first": "$$ROOT"}}},
        {"$replaceRoot": {"newRoot": "$doc"}},
        {"$project": {"filename": 1, "length": 1, "metadata": 1}},
        {"$sort": {"metadata.regionId": 1}},
        {"$limit": MAX_REGIONS},
    ]
    try:
        docs = list(get_database()[FILES_COLLECTION].aggregate(pipeline))
    except (PyMongoError, ValueError):
        return Response(_UNAVAILABLE, status=503, headers={"Cache-Control": "no-store"})
    regions = [r for r in (_region_summary(d) for d in docs) if r is not None]
    return Response({"regions": regions}, headers={"Cache-Control": "public, max-age=60"})


def _etag_matches(header: str, etag: str) -> bool:
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate == "*" or candidate.removeprefix("W/") == etag:
            return True
    return False


def _stream(stream):
    try:
        while True:
            chunk = stream.readchunk()
            if not chunk:
                break
            yield chunk
    finally:
        stream.close()


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def landscape_package(request, region_id: str):
    """Stream the newest package for a region as gzip bytes."""
    if not REGION_ID_PATTERN.fullmatch(region_id):
        return Response(_NOT_FOUND, status=404)
    try:
        db = get_database()
        doc = db[FILES_COLLECTION].find_one(
            {"metadata.regionId": region_id},
            projection={"filename": 1, "length": 1},
            sort=[("metadata.builtAt", -1), ("uploadDate", -1)],
        )
        if doc is None:
            return Response(_NOT_FOUND, status=404, headers={"Cache-Control": "no-store"})
        sha = doc.get("filename")
        if not isinstance(sha, str) or not SHA256_PATTERN.fullmatch(sha):
            return Response(_UNAVAILABLE, status=503, headers={"Cache-Control": "no-store"})
        etag = f'"{sha}"'
        headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
        if _etag_matches(request.headers.get("If-None-Match", ""), etag):
            return HttpResponse(status=304, headers=headers)
        if request.method == "HEAD":
            response = HttpResponse(content_type="application/gzip", headers=headers)
            response["Content-Length"] = str(doc["length"])
            return response
        stream = gridfs.GridFSBucket(db, bucket_name=BUCKET).open_download_stream(doc["_id"])
        response = StreamingHttpResponse(
            _stream(stream), content_type="application/gzip", headers=headers
        )
        response["Content-Length"] = str(stream.length)
        return response
    except (PyMongoError, GridFSError, ValueError):
        return Response(_UNAVAILABLE, status=503, headers={"Cache-Control": "no-store"})
