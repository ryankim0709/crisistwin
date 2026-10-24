"""Bearer-token auth for the live API (docs/live-reports.md "Auth", "Controller auth (v2)").

No controller token required by default: with ``LIVE_CONTROLLER_TOKEN`` unset, a request
without an ``Authorization`` header is the controller, so the /live console needs no token.
Setting it locks the controller behind that bearer token again (use that for any shared
deployment). Otherwise fails closed: an unknown or expired token, or an unset invite code, is
refused. Device tokens are stored only as SHA-256 hashes; the controller token is never stored,
only compared in constant time with ``LIVE_CONTROLLER_TOKEN``.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import logging
import secrets
from collections.abc import Callable, Collection
from dataclasses import dataclass
from datetime import timedelta

from django.core.cache import cache
from livecore.drill import INCIDENT_ID
from pymongo.errors import PyMongoError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny

from .common import ApiError, col, error, live_setting, wall_now

log = logging.getLogger(__name__)

CIVILIAN_TOKEN_TTL = timedelta(days=30)
"""Civilian tokens expire 30 days after last use."""
RESPONDER_TOKEN_TTL = timedelta(hours=24)
"""Responder tokens expire 24 h after joining."""
LAST_SEEN_WRITE_INTERVAL = timedelta(minutes=5)
CONTROLLER_PARTY_KEY = "controller"
INCIDENTS = frozenset({INCIDENT_ID})


@dataclass(frozen=True)
class Principal:
    role: str  # civilian | responder | controller
    party_key: str
    incident_id: str | None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(role: str, prefix: str, incident_id: str | None) -> dict:
    """Create a device document and return the one-time response body."""
    token = secrets.token_urlsafe(32)
    party_key = f"{prefix}{secrets.token_hex(8)}"
    now = wall_now()
    ttl = CIVILIAN_TOKEN_TTL if role == "civilian" else RESPONDER_TOKEN_TTL
    col("live_devices").insert_one(
        {
            "token_hash": token_hash(token),
            "role": role,
            "party_key": party_key,
            "incident_id": incident_id,
            "created_at": now,
            "last_seen_at": now,
            "expires_at": now + ttl,
        }
    )
    return {"token": token, "role": role, "party_key": party_key, "incident_id": incident_id}


def secret_matches(given: str, env_name: str) -> bool:
    """Constant-time compare with an env secret; False when the secret is unset."""
    expected = live_setting(env_name)
    if not expected or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


def authenticate(request) -> Principal | None:
    header = request.headers.get("Authorization", "")
    if not header and not live_setting("LIVE_CONTROLLER_TOKEN"):
        return Principal("controller", CONTROLLER_PARTY_KEY, None)
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token or len(token) > 512:
        return None
    if secret_matches(token, "LIVE_CONTROLLER_TOKEN"):
        return Principal("controller", CONTROLLER_PARTY_KEY, None)
    now = wall_now()
    devices = col("live_devices")
    doc = devices.find_one({"token_hash": token_hash(token), "expires_at": {"$gt": now}})
    if doc is None:
        return None
    if now - doc.get("last_seen_at", now) > LAST_SEEN_WRITE_INTERVAL:
        update = {"last_seen_at": now}
        if doc["role"] == "civilian":
            update["expires_at"] = now + CIVILIAN_TOKEN_TTL
        devices.update_one({"_id": doc["_id"]}, {"$set": update})
    return Principal(doc["role"], doc["party_key"], doc.get("incident_id"))


def client_ip(request) -> str:
    return request.META.get("REMOTE_ADDR", "unknown")


def rate_limited(key: str, limit: int, window_s: int) -> bool:
    """Fixed-window counter in the Django cache (per process with the default LocMemCache)."""
    cache_key = f"live-rl:{key}"
    if cache.add(cache_key, 1, timeout=window_s):
        return False
    try:
        count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, timeout=window_s)
        return False
    return count > limit


def live_view(methods: list[str], roles: Collection[str] | None = None, auth: bool = True) -> Callable:
    """DRF function view with live auth, role checks, incident checks and uniform errors.

    ``roles`` None means any authenticated role. The wrapped view receives ``principal``
    (None when ``auth`` is False). A path ``incident_id`` must be a known incident, and a
    responder token only works for the incident it joined.
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(request, *args, **kwargs):
            try:
                incident_id = kwargs.get("incident_id")
                if incident_id is not None and incident_id not in INCIDENTS:
                    return error(404, "not_found", "Unknown incident.")
                principal = None
                if auth:
                    principal = authenticate(request)
                    if principal is None:
                        return error(401, "unauthorized", "Missing or invalid bearer token.")
                    if roles is not None and principal.role not in roles:
                        return error(403, "forbidden", "This role cannot use this endpoint.")
                    if (
                        incident_id is not None
                        and principal.role == "responder"
                        and principal.incident_id not in (None, incident_id)
                    ):
                        return error(403, "forbidden", "This token belongs to another incident.")
                return func(request, *args, principal=principal, **kwargs)
            except ApiError as exc:
                return error(exc.status, exc.code, exc.detail)
            except PyMongoError:
                log.exception("live API: MongoDB error")
                return error(503, "unavailable", "The live data store is unavailable.")

        # DRF reads these attributes off the function, so they go on before api_view.
        func_with_policy = permission_classes([AllowAny])(authentication_classes([])(wrapper))
        return api_view(methods)(func_with_policy)

    return decorator
