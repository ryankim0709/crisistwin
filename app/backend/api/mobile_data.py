"""Mobile data: a schema-free document store in MongoDB Atlas for the iOS app.

The phone never holds an Atlas credential; it talks to this API, which owns the connection
(`api/mongodb.py`). Until the app's schema is designed, any JSON object can be pushed under
a named collection and pulled back. Each phone registers once for a random device token,
returned once and stored here only as a SHA-256 hash; a device sees only its own documents.
Wire contract and limits: docs/adr/0027-mobile-data-store.md.

POST   /api/mobile/devices                     {}                    -> 201 {device_id, device_token}
GET    /api/mobile/data/<collection>           Bearer, ?limit&updated_after -> {documents: [Document]}
POST   /api/mobile/data/<collection>           {data: {...}}         -> 201 Document
GET    /api/mobile/data/<collection>/<id>                            -> Document
PUT    /api/mobile/data/<collection>/<id>      {data: {...}}         -> Document
DELETE /api/mobile/data/<collection>/<id>                            -> 204

Document: {id, collection, data, created_at, updated_at}, timestamps ISO 8601 UTC.
"""

import hashlib
import json
import secrets
from datetime import UTC, datetime

from pymongo import DESCENDING, ReturnDocument
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

from .mongodb import get_database

DEVICES = "mobile_devices"
DOCUMENTS = "mobile_documents"
MAX_DATA_BYTES = 64 * 1024
MAX_DEPTH = 20
MAX_DOCUMENTS_PER_DEVICE = 1000
DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class MobileDataThrottle(AnonRateThrottle):
    scope = "mobile_data"
    rate = "120/min"


class MobileRegisterThrottle(AnonRateThrottle):
    """A device registers once; keep minting tokens slow."""

    scope = "mobile_register"
    rate = "10/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response(
        {"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"}
    )


def _ok(body: dict, status: int = 200) -> Response:
    return Response(body, status=status, headers={"Cache-Control": "no-store"})


def _unavailable() -> Response:
    return _error(503, "database_unavailable", "The mobile data store is unavailable.")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds")


def document_view(doc: dict) -> dict:
    """What the device sees. The owning device id stays on the server."""
    return {
        "id": doc["_id"],
        "collection": doc["collection"],
        "data": doc["data"],
        "created_at": _timestamp(doc["created_at"]),
        "updated_at": _timestamp(doc["updated_at"]),
    }


def _key_problem(value: object, depth: int = 0) -> str | None:
    """Keys MongoDB would treat as operators or paths are rejected, so data stays plain."""
    if depth > MAX_DEPTH:
        return f"`data` nests deeper than {MAX_DEPTH} levels"
    if isinstance(value, dict):
        for key, child in value.items():
            if not key or key.startswith("$") or "." in key or "\x00" in key:
                return f"key {key!r} must be nonempty without `$` prefix, `.` or NUL"
            if problem := _key_problem(child, depth + 1):
                return problem
    elif isinstance(value, list):
        for child in value:
            if problem := _key_problem(child, depth + 1):
                return problem
    return None


def parse_data(request) -> dict | str:
    """The body's `data` object, or an error message."""
    body = request.data if isinstance(request.data, dict) else None
    if body is None or set(body) != {"data"} or not isinstance(body["data"], dict):
        return "Body must be exactly {data: {...}} with a JSON object."
    data = body["data"]
    if len(json.dumps(data, separators=(",", ":")).encode()) > MAX_DATA_BYTES:
        return f"`data` must be at most {MAX_DATA_BYTES} bytes of JSON."
    if problem := _key_problem(data):
        return f"In `data`, {problem}."
    return data


def _authorize(request) -> str | Response:
    """Return the device id for a valid bearer token, else a 401/503 response."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or len(header) > 200:
        return _error(401, "unauthorized", "Send `Authorization: Bearer <device_token>`.")
    try:
        device = get_database()[DEVICES].find_one(
            {"token_hash": _hash(header.removeprefix("Bearer ").strip())}, {"_id": 1}
        )
    except (PyMongoError, ValueError):
        return _unavailable()
    if device is None:
        return _error(401, "unauthorized", "Unknown device token. Register again.")
    return device["_id"]


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([MobileRegisterThrottle])
def register_device(request):
    token = secrets.token_urlsafe(32)
    device = {"_id": secrets.token_hex(12), "token_hash": _hash(token), "created_at": _now()}
    try:
        devices = get_database()[DEVICES]
        devices.create_index("token_hash", unique=True)
        devices.insert_one(device)
    except (PyMongoError, ValueError):
        return _unavailable()
    return _ok({"device_id": device["_id"], "device_token": token}, status=201)


@api_view(["GET", "POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([MobileDataThrottle])
def mobile_collection(request, collection):
    device_id = _authorize(request)
    if isinstance(device_id, Response):
        return device_id
    documents = get_database()[DOCUMENTS]
    scope = {"device_id": device_id, "collection": collection}

    if request.method == "GET":
        try:
            limit = int(request.query_params.get("limit", DEFAULT_LIMIT))
        except ValueError:
            limit = 0
        if not 1 <= limit <= MAX_LIMIT:
            return _error(400, "invalid_request", f"`limit` must be an integer from 1 to {MAX_LIMIT}.")
        query = dict(scope)
        if after := request.query_params.get("updated_after"):
            try:
                since = datetime.fromisoformat(after)
            except ValueError:
                since = None
            if since is None or since.tzinfo is None:
                return _error(400, "invalid_request", "`updated_after` must be ISO 8601 with a UTC offset.")
            query["updated_at"] = {"$gt": since}
        try:
            found = documents.find(query).sort("updated_at", DESCENDING).limit(limit)
            return _ok({"documents": [document_view(doc) for doc in found]})
        except PyMongoError:
            return _unavailable()

    data = parse_data(request)
    if isinstance(data, str):
        return _error(400, "invalid_request", data)
    now = _now()
    doc = {"_id": secrets.token_hex(12), **scope, "data": data, "created_at": now, "updated_at": now}
    try:
        documents.create_index([("device_id", 1), ("collection", 1), ("updated_at", DESCENDING)])
        if documents.count_documents({"device_id": device_id}, limit=MAX_DOCUMENTS_PER_DEVICE) >= MAX_DOCUMENTS_PER_DEVICE:
            return _error(409, "quota_exceeded", f"A device can store at most {MAX_DOCUMENTS_PER_DEVICE} documents.")
        documents.insert_one(doc)
    except PyMongoError:
        return _unavailable()
    return _ok(document_view(doc), status=201)


@api_view(["GET", "PUT", "DELETE"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([MobileDataThrottle])
def mobile_document(request, collection, document_id):
    device_id = _authorize(request)
    if isinstance(device_id, Response):
        return device_id
    documents = get_database()[DOCUMENTS]
    # Same answer for another device's document and a missing one, so ids cannot be probed.
    match = {"_id": document_id, "device_id": device_id, "collection": collection}
    not_found = _error(404, "not_found", "No document with this id in this collection.")
    try:
        if request.method == "GET":
            doc = documents.find_one(match)
        elif request.method == "DELETE":
            if documents.delete_one(match).deleted_count == 0:
                return not_found
            return Response(status=204, headers={"Cache-Control": "no-store"})
        else:
            data = parse_data(request)
            if isinstance(data, str):
                return _error(400, "invalid_request", data)
            doc = documents.find_one_and_update(
                match,
                {"$set": {"data": data, "updated_at": _now()}},
                return_document=ReturnDocument.AFTER,
            )
    except PyMongoError:
        return _unavailable()
    if doc is None:
        return not_found
    return _ok(document_view(doc))
