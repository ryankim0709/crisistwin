"""Shared MongoDB boundary; create the connection pool lazily in each worker."""

import atexit
from threading import Lock
from typing import Any

from django.conf import settings
from pymongo import MongoClient
from pymongo.database import Database

_client: MongoClient[dict[str, Any]] | None = None
_client_lock = Lock()
MONGODB_TIMEOUT_MS = 3000


def get_database() -> Database[dict[str, Any]]:
    """Return the explicit application database, independent of the URI's path."""
    global _client
    with _client_lock:
        if _client is None:
            _client = MongoClient(
                settings.MONGODB_CONNECTION_SECRET,
                appname="crisistwin-api",
                connect=False,
                tz_aware=True,
                serverSelectionTimeoutMS=MONGODB_TIMEOUT_MS,
                connectTimeoutMS=MONGODB_TIMEOUT_MS,
                socketTimeoutMS=MONGODB_TIMEOUT_MS,
                timeoutMS=MONGODB_TIMEOUT_MS,
            )
            atexit.register(_client.close)
    return _client[settings.MONGODB_DATABASE]
