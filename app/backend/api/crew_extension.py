"""Board-area roads for fire-unit legs past the drill's road box (``POST /api/demo/crew_routes``).

A drill package's road graph is the dispatch area of its build box (``livecore.package.area_box``:
the first Studio run's reach plus 3 km). A later Studio fire on the same board can burn outside
that box, where the drill graph has no roads, so every unit's leg stops at the box edge however
close real roads are (Berkeley Hills drill: box to 37.900 N; a fire at 37.913 N parked units
1.4-1.7 km away while OpenStreetMap has a track 143 m from it).

The diorama draws its streets from the dispatch areas of the board (``GET /api/dispatch/area``,
cached per box in MongoDB; ``app/src/fire/useBoardStreets.ts``). This module routes a leg's last
stretch on the cached dispatch area that covers both the drill leg's end and the target, with the
same apparatus access rules (``livecore.apparatus.access_profile`` on the area's OSM tags). Only
areas already in the cache are used: nothing here calls Overpass. Units: WGS84 (lon, lat), metres.
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
from dataclasses import replace

from livecore.apparatus import access_profile
from livecore.drill import Drill, _road_graph
from livecore.geo import LonLat
from livecore.package import _roads

from .dispatch_area import BUILDER_VERSION, COLLECTION

logger = logging.getLogger(__name__)

EXTENSION_TRY_MIN_M = 150.0
"""ASSUMPTION: a leg that ends farther than this from its target (straight line) tries the
board-area roads; closer, the gap is a short hose lay or hike and the drill leg stands."""
EXTENSION_JOIN_MAX_M = 50.0
"""ASSUMPTION: the drill leg's end must lie within this of a board-area road node for the two
legs to join. Both graphs are the same OSM ways cut at different box edges, so the end of a drill
road is on (or metres from) the same road in the larger area; a bigger gap is not the same road."""
AREA_LIST_TTL_S = 60.0
"""How long the list of cached area boxes is reused before MongoDB is asked again, seconds."""
MAX_AREA_GRAPHS = 4
"""Board-area graphs kept in process (one area is a few MB parsed)."""

_lock = threading.Lock()
_boxes: tuple[float, list[tuple[str, tuple[float, float, float, float]]]] = (0.0, [])
_graphs: dict[tuple[int, str], Drill] = {}


def _cached_boxes() -> list[tuple[str, tuple[float, float, float, float]]]:
    """(cache key, (west, south, east, north)) of every dispatch area in the MongoDB cache."""
    global _boxes
    now = time.monotonic()
    if now - _boxes[0] < AREA_LIST_TTL_S:
        return _boxes[1]
    from .mongodb import get_database

    out = []
    try:
        for doc in get_database()[COLLECTION].find({"builder": BUILDER_VERSION}, {"_id": 1}):
            try:
                w, s, e, n = (float(v) for v in str(doc["_id"]).split(":", 1)[1].split(","))
            except (IndexError, ValueError):
                continue
            out.append((str(doc["_id"]), (w, s, e, n)))
    except Exception:  # noqa: BLE001 - the cache is optional; without it legs stay on the drill roads
        logger.warning("dispatch area cache unavailable; crew legs stay on the drill roads")
    _boxes = (now, out)
    return out


def _inside(p: LonLat, box: tuple[float, float, float, float]) -> bool:
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]


def board_area_drill(drill: Drill, leg_end: LonLat, target: LonLat) -> tuple[str, Drill] | None:
    """The drill with its roads replaced by the smallest cached dispatch area covering both
    ``leg_end`` and ``target`` (zones, clock and the rest are the drill's), and that area's cache
    key; None when no cached area covers both."""
    boxes = [(k, b) for k, b in _cached_boxes() if _inside(leg_end, b) and _inside(target, b)]
    if not boxes:
        return None
    key, _ = min(boxes, key=lambda kb: ((kb[1][2] - kb[1][0]) * (kb[1][3] - kb[1][1]), kb[0]))
    with _lock:
        hit = _graphs.get((id(drill), key))
        if hit is not None:
            return key, hit
    from .mongodb import get_database

    try:
        doc = get_database()[COLLECTION].find_one({"_id": key, "builder": BUILDER_VERSION})
        area = json.loads(gzip.decompress(bytes(doc["gz"]))) if doc and doc.get("gz") else None
        graph = replace(drill, roads=_road_graph(_roads(area)), incident_id=f"{drill.incident_id}#{key}") if area else None
    except Exception:  # noqa: BLE001 - a bad cache entry leaves the drill leg as it is
        logger.exception("dispatch area %s could not be used for crew legs", key)
        return None
    if graph is None:
        return None
    with _lock:
        if len(_graphs) >= MAX_AREA_GRAPHS:
            _graphs.pop(next(iter(_graphs)))
        _graphs[(id(drill), key)] = graph
    return key, graph


def board_area_profile(graph: Drill, access_class: str):
    """The class's road access on the board-area graph (OSM tags on the area's edges; no grade
    data: ``livecore.apparatus`` assumes 0%, as for a drill without a DEM)."""
    return access_profile(graph, access_class, None)
