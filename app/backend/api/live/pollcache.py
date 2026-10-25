"""Coalesce the controller console's heavy polls (several /live tabs) into one computation.

Every open /live tab polls ``command`` (3 s) and ``twin`` (5 s); each computation is a dozen
sequential MongoDB round trips, and on the Atlas free tier those queue behind any bulk write
(``run_state``'s household writer), so N tabs multiplied the load exactly when the cluster was
slowest. ``cached`` answers identical polls of one incident from one computation for
``LIVE_POLL_CACHE_TTL_S`` (default 1.5 s; 0 turns it off), and requests that arrive while it runs
wait for it instead of starting their own (single flight).

A write through the live API (any non-GET ``live_view``, ``auth.py``) bumps a generation, so the
poll right after a console action recomputes. Writes from other processes or background threads
show within the TTL. Bodies are shared between requests: callers must not mutate them.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from django.conf import settings

_lock = threading.Lock()
_entries: dict[tuple[str, str], tuple[float, tuple[int, int], Any]] = {}
_flights: dict[tuple[str, str], threading.Lock] = {}
_generations: dict[str, int] = {}
_global_generation = 0


def _generation(incident_id: str) -> tuple[int, int]:
    return _global_generation, _generations.get(incident_id, 0)


def bump(incident_id: str | None = None) -> None:
    """A write happened: drop what was cached for ``incident_id`` (every incident when None)."""
    global _global_generation
    with _lock:
        if incident_id is None:
            _global_generation += 1
        else:
            _generations[incident_id] = _generations.get(incident_id, 0) + 1


def cached(kind: str, incident_id: str, compute: Callable[[], Any]) -> Any:
    """``compute()``, or the body another request of the same ``kind`` and incident computed within the TTL."""
    ttl = float(getattr(settings, "LIVE_POLL_CACHE_TTL_S", 1.5))
    if ttl <= 0:
        return compute()
    key = (kind, incident_id)
    with _lock:
        flight = _flights.setdefault(key, threading.Lock())
    with flight:
        with _lock:
            hit = _entries.get(key)
            generation = _generation(incident_id)
        if hit is not None and hit[0] > time.monotonic() and hit[1] == generation:
            return hit[2]
        body = compute()
        with _lock:
            if _generation(incident_id) == generation:  # no write landed meanwhile
                _entries[key] = (time.monotonic() + ttl, generation, body)
        return body
