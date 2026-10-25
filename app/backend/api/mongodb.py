"""Shared MongoDB boundary; create the connection pool lazily in each worker."""

import atexit
from threading import Lock
from typing import Any

from django.conf import settings
from pymongo import MongoClient
from pymongo.database import Database

_client: MongoClient[dict[str, Any]] | None = None
_cache_client: MongoClient[dict[str, Any]] | None = None
_client_lock = Lock()
MONGODB_TIMEOUT_MS = 3000
"""Fail fast when the cluster is unreachable (server selection and connect)."""
MONGODB_OPERATION_TIMEOUT_MS = 15000
"""Whole-operation budget: multi-MB reads (a drill document, a stored Studio landscape) take
more than 3 s from Atlas."""


def _new_client(uri: str) -> MongoClient[dict[str, Any]]:
    client: MongoClient[dict[str, Any]] = MongoClient(
        uri,
        appname="crisistwin-api",
        connect=False,
        tz_aware=True,
        serverSelectionTimeoutMS=MONGODB_TIMEOUT_MS,
        connectTimeoutMS=MONGODB_TIMEOUT_MS,
        socketTimeoutMS=MONGODB_OPERATION_TIMEOUT_MS,
        timeoutMS=MONGODB_OPERATION_TIMEOUT_MS,
    )
    atexit.register(client.close)
    return client


def get_database() -> Database[dict[str, Any]]:
    """Return the explicit application database, independent of the URI's path."""
    global _client
    with _client_lock:
        if _client is None:
            _client = _new_client(settings.MONGODB_CONNECTION_SECRET)
    return _client[settings.MONGODB_DATABASE]


def get_cache_database() -> Database[dict[str, Any]]:
    """Database for the large, rebuildable caches (geo tiles, landscape grids, conditions).

    Defaults to the application database. Set CACHE_MONGODB_URI / CACHE_MONGODB_DATABASE to keep
    the caches elsewhere, e.g. a local mongod next to the API while app data stays on Atlas
    (docs/deploy.md). Only caches may use it: nothing here is the system of record.
    """
    global _cache_client
    if settings.CACHE_MONGODB_CONNECTION_SECRET == settings.MONGODB_CONNECTION_SECRET:
        return get_database().client[settings.CACHE_MONGODB_DATABASE]
    with _client_lock:
        if _cache_client is None:
            _cache_client = _new_client(settings.CACHE_MONGODB_CONNECTION_SECRET)
    return _cache_client[settings.CACHE_MONGODB_DATABASE]
