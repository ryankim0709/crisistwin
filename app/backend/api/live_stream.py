"""GET /api/live/stream: the live broadcast pushed as Server-Sent Events from a MongoDB change stream.

`GET /api/live` (live_broadcast.py) makes the resident app poll every few seconds. This endpoint
watches the `live_broadcast` document with an Atlas change stream instead and sends every new
snapshot the moment a page posts it, in the same envelope as `GET /api/live`:

    retry: 3000

    id: <resume token>
    event: snapshot
    data: {"snapshot": {...}, "received_at": "2026-10-24T16:22:01.123Z"}

    event: cleared            (the broadcast document was deleted)
    data: {}

    : keep-alive              (comment every HEARTBEAT_SECONDS while nothing changes)

The current snapshot is sent first unless the client resumes with `Last-Event-ID` (the change
stream's resume token), in which case it gets exactly the changes it missed. A stream ends after
MAX_STREAM_SECONDS (the client reconnects) or with `event: error` when the database fails; at most
MAX_STREAMS are open per worker (503 beyond). Change streams need a replica set (Atlas has one);
without one the endpoint answers 503 and clients keep polling `GET /api/live`. Everything sent
is simulated, never an official alert. See docs/adr/0033-live-change-stream.md.
"""

import json
import re
import time
from collections.abc import Callable, Iterator
from threading import BoundedSemaphore

from django.http import HttpRequest, HttpResponse, JsonResponse, StreamingHttpResponse
from pymongo.errors import OperationFailure, PyMongoError

from .live_broadcast import COLLECTION, DOC_ID
from .mongodb import get_database

MAX_STREAMS = 32
HEARTBEAT_SECONDS = 15
MAX_STREAM_SECONDS = 600
# getMore wait; must stay under the client's 3 s operation timeout (mongodb.py).
AWAIT_MS = 1000
RETRY_MS = 3000
RESUME_TOKEN = re.compile(r"^[0-9A-Fa-f]{16,512}$")
PIPELINE = [{"$match": {"documentKey._id": DOC_ID}}]

_slots = BoundedSemaphore(MAX_STREAMS)


def envelope(doc: dict) -> dict:
    """The `GET /api/live` body for a stored broadcast document."""
    return {"snapshot": doc["snapshot"], "received_at": doc["received_at"].isoformat(timespec="milliseconds")}


def sse(event: str, data: dict, event_id: str | None = None) -> str:
    head = f"id: {event_id}\n" if event_id else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, separators=(',', ':'), ensure_ascii=False)}\n\n"


class BroadcastStream:
    """Iterates SSE text from an open change stream; `close()` frees the stream and its slot."""

    def __init__(self, changes, first: dict | None, clock: Callable[[], float] = time.monotonic):
        self._changes = changes
        self._first = first
        self._clock = clock
        self._closed = False
        self._events = self._run()

    def __iter__(self) -> Iterator[str]:
        return self

    def __next__(self) -> str:
        return next(self._events)

    def _run(self) -> Iterator[str]:
        started = last = self._clock()
        yield f"retry: {RETRY_MS}\n\n"
        if self._first is not None:
            yield sse("snapshot", envelope(self._first))
        try:
            while self._changes.alive:
                change = self._changes.try_next()
                now = self._clock()
                if change is not None:
                    token = (change.get("_id") or {}).get("_data")
                    if change.get("operationType") == "delete":
                        yield sse("cleared", {}, token)
                    elif change.get("fullDocument"):
                        yield sse("snapshot", envelope(change["fullDocument"]), token)
                    last = now
                elif now - last >= HEARTBEAT_SECONDS:
                    yield ": keep-alive\n\n"
                    last = now
                if now - started >= MAX_STREAM_SECONDS:
                    return
        except (PyMongoError, ValueError, KeyError):
            yield sse("error", {"error": "database_unavailable", "detail": "The live stream stopped; reconnect."})

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._changes.close()
        finally:
            _slots.release()


def _open(resume: str | None):
    """The change stream, and the current document unless resuming."""
    collection = get_database()[COLLECTION]
    if resume:
        try:
            return collection.watch(
                PIPELINE, full_document="updateLookup", max_await_time_ms=AWAIT_MS, resume_after={"_data": resume}
            ), None
        except OperationFailure:
            pass  # Token too old for the oplog: start over from the current snapshot.
    # Open before reading so nothing posted in between is missed.
    changes = collection.watch(PIPELINE, full_document="updateLookup", max_await_time_ms=AWAIT_MS)
    try:
        return changes, collection.find_one({"_id": DOC_ID})
    except BaseException:
        changes.close()
        raise


def live_stream(request: HttpRequest) -> HttpResponse:
    if request.method != "GET":
        return JsonResponse({"error": "method_not_allowed", "detail": "Use GET."}, status=405)
    if not _slots.acquire(blocking=False):
        return JsonResponse(
            {"error": "busy", "detail": "Too many live streams open; poll GET /api/live."},
            status=503,
            headers={"Cache-Control": "no-store", "Retry-After": "10"},
        )
    resume = request.headers.get("Last-Event-ID", "").strip()
    try:
        changes, first = _open(resume if RESUME_TOKEN.match(resume) else None)
    except (PyMongoError, ValueError):
        _slots.release()
        return JsonResponse(
            {"error": "stream_unavailable", "detail": "Live push is unavailable; poll GET /api/live."},
            status=503,
            headers={"Cache-Control": "no-store"},
        )
    response = StreamingHttpResponse(BroadcastStream(changes, first), content_type="text/event-stream")
    response["Cache-Control"] = "no-store"
    response["X-Accel-Buffering"] = "no"
    return response
