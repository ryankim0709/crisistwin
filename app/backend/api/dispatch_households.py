"""GET /api/dispatch/households?bbox=w,s,e,n: the households of the current scenario resource
snapshots inside a box, gridded, for the /dispatch people picture.

Read-only. The households are the ``snapshot_households`` documents that ``live_seed_snapshots``
writes (scenario resource snapshots): one row per household with a point, occupants, vehicles,
evacuating vehicles and a needs-transport flag, every value ``basis: "estimated"``. Only the
current snapshot of each incident (``scenario_snapshots``) is read, so a half-written re-seed is
never served. The database is the application database (``MONGODB_URI`` /
``MONGODB_DATABASE``): Atlas in a deployment, the local dev database on a laptop.

Households are summed server-side into CELL_DEG grid cells (about 160 m), because shipping
20,000 single documents from a shared Atlas tier takes 20-40 s; a cell's point is the mean
of its households' points. The page assigns each cell to the nearest synthetic home of its
dispatch area (src/dispatch/households.ts). No snapshot in the box, or MongoDB unavailable,
returns no cells with a note: the page then keeps its synthetic estimate.

Response (``schema_version`` 1)::

    {
      "kind": "crisistwin_dispatch_households", "schema_version": 1,
      "bbox": [w, s, e, n], "cell_deg": 0.0015,
      "fields": ["lon", "lat", "households", "occupants", "evacuating_vehicles",
                 "needs_transport_occupants"],
      "cells": [[-122.25, 37.86, 4, 9, 6, 0], ...],
      "sources": [{"incident_id": "...", "snapshot_id": "...", "households": 1234}],
      "basis": "estimated", "note": null
    }

Coordinates are WGS84 degrees, lon first. Counts are sums over the cell's households.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from typing import Any

from django.core.exceptions import ImproperlyConfigured
from pymongo.errors import PyMongoError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .dispatch_area import MAX_ABS_LAT, MAX_LAT_SPAN_DEG, MAX_LON_SPAN_DEG
from .mongodb import get_database

logger = logging.getLogger(__name__)

SNAPSHOTS = "scenario_snapshots"
HOUSEHOLDS = "snapshot_households"
CELL_DEG = 0.0015
FIELDS = ["lon", "lat", "households", "occupants", "evacuating_vehicles", "needs_transport_occupants"]
CACHE_SECONDS = 600
CACHE_ENTRIES = 16
_MONGO_ERRORS = (PyMongoError, ValueError, ImproperlyConfigured, AttributeError, TypeError)

_cache: OrderedDict[tuple[float, ...], tuple[float, dict[str, Any]]] = OrderedDict()
_cache_lock = threading.Lock()


def _bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    parts = (raw or "").split(",")
    if len(parts) != 4:
        return None
    try:
        w, s, e, n = (float(p) for p in parts)
    except ValueError:
        return None
    if not all(math.isfinite(v) for v in (w, s, e, n)) or w >= e or s >= n:
        return None
    if abs(s) >= MAX_ABS_LAT or abs(n) >= MAX_ABS_LAT:
        return None
    # About a dispatch area's (snapped) box.
    if e - w > MAX_LON_SPAN_DEG + 0.05 or n - s > MAX_LAT_SPAN_DEG + 0.05:
        return None
    return round(w, 4), round(s, 4), round(e, 4), round(n, 4)


def _body(box, cells, sources, note) -> dict[str, Any]:
    return {
        "kind": "crisistwin_dispatch_households",
        "schema_version": 1,
        "bbox": list(box),
        "cell_deg": CELL_DEG,
        "fields": FIELDS,
        "cells": cells,
        "sources": sources,
        "basis": "estimated",
        "note": note,
    }


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0


def households_in(box: tuple[float, float, float, float]) -> dict[str, Any]:
    """The response body for ``box``. Raises a MongoDB error when the database is unavailable."""
    w, s, e, n = box
    db = get_database()
    current = {
        doc["snapshot_id"]: doc.get("incident_id")
        for doc in db[SNAPSHOTS].find({}, {"_id": 0, "snapshot_id": 1, "incident_id": 1})
        if doc.get("snapshot_id")
    }
    if not current:
        return _body(box, [], [], "No scenario resource snapshot is stored.")
    lon = {"$arrayElemAt": ["$location.coordinates", 0]}
    lat = {"$arrayElemAt": ["$location.coordinates", 1]}
    pipeline = [
        {
            "$match": {
                "snapshot_id": {"$in": list(current)},
                "location": {
                    "$geoWithin": {
                        "$geometry": {
                            "type": "Polygon",
                            "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
                        }
                    }
                },
            }
        },
        {
            "$group": {
                "_id": {
                    "x": {"$floor": {"$divide": [lon, CELL_DEG]}},
                    "y": {"$floor": {"$divide": [lat, CELL_DEG]}},
                    "s": "$snapshot_id",
                },
                "lon": {"$avg": lon},
                "lat": {"$avg": lat},
                "households": {"$sum": 1},
                "occupants": {"$sum": "$occupants.value"},
                "vehicles": {"$sum": "$evacuating_vehicles.value"},
                "transport": {"$sum": {"$cond": ["$needs_transport", "$occupants.value", 0]}},
            }
        },
        {"$project": {"_id": 0, "s": "$_id.s", "lon": 1, "lat": 1, "households": 1, "occupants": 1, "vehicles": 1, "transport": 1}},
    ]
    cells: list[list[float]] = []
    counts: dict[str, int] = {}
    for doc in db[HOUSEHOLDS].aggregate(pipeline, batchSize=20_000):
        households = int(_number(doc.get("households")))
        cells.append([
            round(_number(doc.get("lon")), 6),
            round(_number(doc.get("lat")), 6),
            households,
            _number(doc.get("occupants")),
            _number(doc.get("vehicles")),
            _number(doc.get("transport")),
        ])
        counts[doc["s"]] = counts.get(doc["s"], 0) + households
    sources = [
        {"incident_id": current[sid], "snapshot_id": sid, "households": count}
        for sid, count in sorted(counts.items())
    ]
    return _body(box, cells, sources, None if cells else "No household snapshot covers this area.")


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def dispatch_households(request):
    box = _bbox(request.query_params.get("bbox"))
    if box is None:
        return Response(
            {"error": "bad_bbox", "detail": "bbox must be west,south,east,north in degrees, about a dispatch area in size."},
            status=400,
        )
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(box)
        if hit and now - hit[0] < CACHE_SECONDS:
            return Response(hit[1], headers={"Cache-Control": "no-store"})
    try:
        body = households_in(box)
    except _MONGO_ERRORS:
        logger.warning("dispatch households: MongoDB unavailable", exc_info=True)
        return Response(
            _body(box, [], [], "Household snapshots are unavailable (database)."),
            headers={"Cache-Control": "no-store"},
        )
    with _cache_lock:
        _cache[box] = (now, body)
        _cache.move_to_end(box)
        while len(_cache) > CACHE_ENTRIES:
            _cache.popitem(last=False)
    return Response(body, headers={"Cache-Control": "no-store"})
