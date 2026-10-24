"""Shared helpers for the live API: time, ids, errors, request bodies, collections."""

from __future__ import annotations

import json
import math
import re
import secrets
import time
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from django.conf import settings
from pymongo.collection import Collection
from rest_framework.response import Response

from ..mongodb import get_database

MAX_BODY_BYTES = 32_000
NO_STORE = {"Cache-Control": "no-store"}


class ApiError(Exception):
    """Raised inside a view to return ``{error, detail}`` with ``status``."""

    def __init__(self, status: int, code: str, detail: str = "") -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def error(status: int, code: str, detail: str = "") -> Response:
    body: dict[str, Any] = {"error": code}
    if detail:
        body["detail"] = detail
    return Response(body, status=status, headers=NO_STORE)


def ok(body: Any, status: int = 200) -> Response:
    return Response(body, status=status, headers=NO_STORE)


def wall_now() -> datetime:
    """Wall clock, UTC, truncated to milliseconds (BSON date precision)."""
    now = datetime.now(UTC)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Any, field: str, code: str) -> datetime:
    """Parse an ISO 8601 time with an explicit zone; raise ``ApiError(400, code)`` otherwise."""
    if not isinstance(value, str) or not value:
        raise ApiError(400, code, f"`{field}` must be an ISO 8601 time with Z.")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ApiError(400, code, f"`{field}` must be an ISO 8601 time with Z.") from exc
    if parsed.tzinfo is None:
        raise ApiError(400, code, f"`{field}` must include a time zone (Z).")
    parsed = parsed.astimezone(UTC)
    return parsed.replace(microsecond=parsed.microsecond // 1000 * 1000)


def new_id(prefix: str) -> str:
    """Prefixed, roughly time-ordered opaque id, e.g. ``rpt_0192f3a1b2c4d5e6f7a8b9``."""
    return f"{prefix}{int(time.time() * 1000):012x}{secrets.token_hex(5)}"


def json_body(request, code: str = "invalid_request") -> dict[str, Any]:
    """The JSON object body; an empty body is ``{}``."""
    raw = request.body
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError(413, "too_large", f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, code, "Body must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise ApiError(400, code, "Body must be a JSON object.")
    return data


def parse_coord(value: Any, field: str, code: str) -> tuple[float, float]:
    """``[lon, lat]`` in WGS84 decimal degrees."""
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)
    ):
        raise ApiError(400, code, f"`{field}` must be [lon, lat].")
    lon, lat = float(value[0]), float(value[1])
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise ApiError(400, code, f"`{field}` must be [lon, lat] in WGS84 degrees.")
    return lon, lat


def coord_list(coord: Any) -> list[float] | None:
    if coord is None:
        return None
    return [float(coord[0]), float(coord[1])]


def optional_str(data: dict[str, Any], key: str, code: str, max_len: int = 500) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > max_len:
        raise ApiError(400, code, f"`{key}` must be a string of at most {max_len} characters.")
    return value.strip() or None


def col(name: str) -> Collection[dict[str, Any]]:
    return get_database()[name]


def live_setting(name: str) -> str:
    return (getattr(settings, name, "") or "").strip()


# ---- actor attribution (ADR 0030 "Controller surface"; docs/live-reports.md "Actor attribution") ----

ACTOR_HEADER = "X-CrisisTwin-Actor"
ACTOR_PATTERN = re.compile(r"^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
"""An agent driving the controller API names itself ``agent:<name>``; anything else is ignored."""
_request_actor: ContextVar[str | None] = ContextVar("live_request_actor", default=None)


def actor_from_request(request) -> str | None:
    """The ``X-CrisisTwin-Actor`` header when it is a valid ``agent:<name>``, else None."""
    value = (request.headers.get(ACTOR_HEADER) or "").strip()
    return value if ACTOR_PATTERN.match(value) else None


def set_request_actor(actor: str | None):
    """Set for one controller request (``live_view``); returns the token for ``reset_request_actor``."""
    return _request_actor.set(actor)


def reset_request_actor(token) -> None:
    _request_actor.reset(token)


def decision_actor(actor: str) -> str:
    """The actor to record: a controller request's agent id replaces the generic ``controller``."""
    return (_request_actor.get() or actor) if actor == "controller" else actor
