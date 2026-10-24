"""Families: a household circle that shares meeting points and member status.

A family is created by one member and joined by others with its join code. Every member
gets a random bearer token, returned once and stored here only as a SHA-256 hash; every
read and write of a family needs a member's token. Status is a fixed choice (safe, on the
way, ...), never a live location. Wire contract: docs/adr/0016-resident-live-and-family.md.

POST   /api/families                         {family_name, member_name}   -> 201 Membership
POST   /api/families/join                    {join_code, member_name}     -> 201 Membership
GET    /api/families/<id>                    Bearer token                 -> Family
PUT    /api/families/<id>/meeting-points     {primary, backup}            -> Family
PUT    /api/families/<id>/members/me         {status}                     -> Family
DELETE /api/families/<id>/members/me                                      -> 204
"""

import hashlib
import math
import secrets
from datetime import UTC, datetime

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
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

COLLECTION = "families"
MAX_NAME_CHARS = 60
MAX_NOTE_CHARS = 200
MAX_MEMBERS = 12
STATUSES = ("unknown", "safe", "on_the_way", "at_meeting_point", "need_help")
# No 0/O, 1/I/L: codes are read aloud and typed on phones.
JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
JOIN_CODE_LENGTH = 8
JOIN_CODE_ATTEMPTS = 5


class FamilyThrottle(AnonRateThrottle):
    """Joining guesses codes; keep guessing slow. Status polling stays well under this."""

    rate = "60/min"


def _error(status: int, code: str, detail: str) -> Response:
    return Response(
        {"error": code, "detail": detail}, status=status, headers={"Cache-Control": "no-store"}
    )


def _ok(body: dict, status: int = 200) -> Response:
    return Response(body, status=status, headers={"Cache-Control": "no-store"})


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _clean_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())
    return name if 0 < len(name) <= MAX_NAME_CHARS else None


def normalize_join_code(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    code = "".join(ch for ch in value.upper() if ch.isalnum())
    if len(code) != JOIN_CODE_LENGTH or any(ch not in JOIN_CODE_ALPHABET for ch in code):
        return None
    return code


def parse_point(value: object) -> dict | None | str:
    """A meeting point {name, note, latitude, longitude} (WGS84 degrees), None, or an error."""
    if value is None:
        return None
    if not isinstance(value, dict):
        return "must be null or an object"
    name = _clean_name(value.get("name"))
    note = value.get("note", "")
    lat, lon = value.get("latitude"), value.get("longitude")
    if name is None:
        return f"name must be 1-{MAX_NAME_CHARS} characters"
    if not isinstance(note, str) or len(note) > MAX_NOTE_CHARS:
        return f"note must be at most {MAX_NOTE_CHARS} characters"
    for coordinate, limit in ((lat, 90), (lon, 180)):
        if isinstance(coordinate, bool) or not isinstance(coordinate, int | float):
            return "latitude and longitude must be numbers"
        if not math.isfinite(coordinate) or abs(coordinate) > limit:
            return "latitude and longitude must be valid WGS84 degrees"
    return {"name": name, "note": note.strip(), "latitude": float(lat), "longitude": float(lon)}


def family_view(doc: dict, member_id: str) -> dict:
    """What a member sees. Token hashes never leave the server."""
    return {
        "id": doc["_id"],
        "name": doc["name"],
        "join_code": doc["join_code"],
        "primary": doc.get("primary"),
        "backup": doc.get("backup"),
        "meeting_points_updated_at": doc["meeting_points_updated_at"].isoformat(timespec="milliseconds"),
        "meeting_points_updated_by": doc.get("meeting_points_updated_by"),
        "members": [
            {
                "id": m["id"],
                "name": m["name"],
                "status": m["status"],
                "status_updated_at": m["status_updated_at"].isoformat(timespec="milliseconds"),
                "is_me": m["id"] == member_id,
            }
            for m in doc["members"]
        ],
    }


def _new_member(name: str) -> tuple[dict, str]:
    token = secrets.token_urlsafe(32)
    member = {
        "id": secrets.token_hex(8),
        "name": name,
        "token_hash": _hash(token),
        "status": "unknown",
        "status_updated_at": _now(),
    }
    return member, token


def _membership(doc: dict, member: dict, token: str) -> dict:
    return {"member_id": member["id"], "member_token": token, "family": family_view(doc, member["id"])}


def _authorize(request, family_id: str) -> tuple[dict, dict] | Response:
    """Return (family, member) for a valid bearer token, else a 401/404 response."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or len(header) > 200:
        return _error(401, "unauthorized", "Send `Authorization: Bearer <member_token>`.")
    token_hash = _hash(header.removeprefix("Bearer ").strip())
    try:
        doc = get_database()[COLLECTION].find_one({"_id": family_id, "members.token_hash": token_hash})
    except (PyMongoError, ValueError):
        return _error(503, "database_unavailable", "The family store is unavailable.")
    if doc is None:
        # Same answer for an unknown family and a wrong token, so ids cannot be probed.
        return _error(404, "not_found", "No family for this id and token. You may have been removed.")
    member = next(m for m in doc["members"] if m["token_hash"] == token_hash)
    return doc, member


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([FamilyThrottle])
def create_family(request):
    family_name = _clean_name(request.data.get("family_name") if isinstance(request.data, dict) else None)
    member_name = _clean_name(request.data.get("member_name") if isinstance(request.data, dict) else None)
    if family_name is None or member_name is None:
        return _error(400, "invalid_request", f"`family_name` and `member_name` must be 1-{MAX_NAME_CHARS} characters.")
    member, token = _new_member(member_name)
    for _ in range(JOIN_CODE_ATTEMPTS):
        now = _now()
        doc = {
            "_id": secrets.token_hex(12),
            "name": family_name,
            "join_code": "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(JOIN_CODE_LENGTH)),
            "primary": None,
            "backup": None,
            "meeting_points_updated_at": now,
            "meeting_points_updated_by": None,
            "members": [member],
            "created_at": now,
        }
        try:
            collection = get_database()[COLLECTION]
            collection.create_index("join_code", unique=True)
            collection.insert_one(doc)
        except DuplicateKeyError:
            continue
        except (PyMongoError, ValueError):
            return _error(503, "database_unavailable", "The family store is unavailable.")
        return _ok(_membership(doc, member, token), status=201)
    return _error(503, "join_code_exhausted", "Could not allocate a join code. Try again.")


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([FamilyThrottle])
def join_family(request):
    data = request.data if isinstance(request.data, dict) else {}
    code = normalize_join_code(data.get("join_code"))
    member_name = _clean_name(data.get("member_name"))
    if code is None or member_name is None:
        return _error(400, "invalid_request", "Send an 8-character `join_code` and a `member_name`.")
    member, token = _new_member(member_name)
    try:
        doc = get_database()[COLLECTION].find_one_and_update(
            {"join_code": code, f"members.{MAX_MEMBERS - 1}": {"$exists": False}},
            {"$push": {"members": member}},
            return_document=ReturnDocument.AFTER,
        )
    except PyMongoError:
        return _error(503, "database_unavailable", "The family store is unavailable.")
    if doc is None:
        return _error(404, "not_found", f"No family with that code, or it already has {MAX_MEMBERS} members.")
    return _ok(_membership(doc, member, token), status=201)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([FamilyThrottle])
def family_detail(request, family_id):
    auth = _authorize(request, family_id)
    if isinstance(auth, Response):
        return auth
    doc, member = auth
    return _ok(family_view(doc, member["id"]))


@api_view(["PUT"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([FamilyThrottle])
def family_meeting_points(request, family_id):
    auth = _authorize(request, family_id)
    if isinstance(auth, Response):
        return auth
    _, member = auth
    data = request.data if isinstance(request.data, dict) else {}
    if set(data) != {"primary", "backup"}:
        return _error(400, "invalid_request", "Body must be exactly {primary, backup}.")
    primary, backup = parse_point(data["primary"]), parse_point(data["backup"])
    for label, point in (("primary", primary), ("backup", backup)):
        if isinstance(point, str):
            return _error(400, "invalid_request", f"`{label}` {point}.")
    if primary is None and backup is not None:
        return _error(400, "invalid_request", "Set a primary meeting point before a backup.")
    try:
        doc = get_database()[COLLECTION].find_one_and_update(
            {"_id": family_id},
            {"$set": {
                "primary": primary,
                "backup": backup,
                "meeting_points_updated_at": _now(),
                "meeting_points_updated_by": member["name"],
            }},
            return_document=ReturnDocument.AFTER,
        )
    except PyMongoError:
        return _error(503, "database_unavailable", "The family store is unavailable.")
    if doc is None:
        return _error(404, "not_found", "This family no longer exists.")
    return _ok(family_view(doc, member["id"]))


@api_view(["PUT", "DELETE"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([FamilyThrottle])
def family_member_me(request, family_id):
    auth = _authorize(request, family_id)
    if isinstance(auth, Response):
        return auth
    _, member = auth
    collection = get_database()[COLLECTION]
    try:
        if request.method == "DELETE":
            collection.update_one({"_id": family_id}, {"$pull": {"members": {"id": member["id"]}}})
            # The last member out deletes the family, so no orphan keeps its points.
            collection.delete_one({"_id": family_id, "members": {"$size": 0}})
            return Response(status=204, headers={"Cache-Control": "no-store"})
        status = request.data.get("status") if isinstance(request.data, dict) else None
        if status not in STATUSES:
            return _error(400, "invalid_request", f"`status` must be one of {list(STATUSES)}.")
        doc = collection.find_one_and_update(
            {"_id": family_id, "members.id": member["id"]},
            {"$set": {"members.$.status": status, "members.$.status_updated_at": _now()}},
            return_document=ReturnDocument.AFTER,
        )
    except PyMongoError:
        return _error(503, "database_unavailable", "The family store is unavailable.")
    if doc is None:
        return _error(404, "not_found", "You are no longer in this family.")
    return _ok(family_view(doc, member["id"]))
