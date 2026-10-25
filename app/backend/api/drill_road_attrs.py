"""OSM access tags and terrain grade for a drill's roads (``livecore.road_attrs.RoadAttrs``).

The drill bundles carry no surface, tracktype, width, weight or grade per edge, so the road access
rules R01-R12 (docs/suppression-data.md) close nothing on them. This adapter fills that in for
crew routing (``api.demo_realism``; docs/command-demo-realism.md "Road access"):

- **Tags**: the drill's edge ids carry the OSM way id (``osm-way:<id>:<n>:<f|r>``, camp-2018). The
  ways' current tags are fetched from Overpass by id (``dispatch_area.overpass``, same mirrors and
  user agent); ways deleted or merged since get their tags as of OSM_ATTIC_DATE (Overpass attic
  query). Observed OSM data, not the drill's 2018 snapshot: a way re-tagged since is judged on
  today's tags (ASSUMPTION: surface and width rarely change).
- **Grade**: the steepest 150 m windowed grade of each segment (``road_attrs.polyline_grade_pct``)
  from the Camp package's USGS 3DEP 1 arc-second DEM (``normalized/terrain_grid.json``, read with
  its manifest checksum). Other incidents: no grade (0% assumed, labelled).

Caching: in process, then MongoDB ``dispatch_areas`` (the dispatch-area cache collection) under
``builder: TAGS_BUILDER``, keyed by incident and a hash of the way ids. A first fetch takes about
a minute, so it runs in a background thread; until it lands ``get_road_attrs`` answers with the
grades alone (``status: "grade_only"``) and callers label it. Nothing here is written anywhere
else.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import threading
import time
from datetime import UTC, datetime

from bson import Binary

from livecore.drill import INCIDENT_ID as CAMP_INCIDENT_ID
from livecore.road_attrs import (
    GRADE_MEDIAN_HALF_M,
    GRADE_SAMPLE_M,
    GRADE_WINDOW_M,
    RoadAttrs,
    bilinear,
    drill_way_ids,
    segment_grades,
    segment_tags,
)

from . import dispatch_area
from .mongodb import get_database

logger = logging.getLogger(__name__)

TAGS_BUILDER = "drill-road-tags/1"
OVERPASS_IDS_PER_QUERY = 3000
"""Way ids per Overpass request (the query is POSTed; ~30 kB of ids)."""
OSM_ATTIC_DATE = {CAMP_INCIDENT_ID: "2018-11-08T00:00:00Z"}
"""Per incident: the OSM date the drill's roads were taken at, for ways no longer current."""
TAG_KEYS = tuple(dispatch_area.TAG_KEYS) + ("4wd_only",)
RETRY_AFTER_FAILURE_S = 600
"""After a failed fetch, wait this long before trying Overpass again for that incident."""

_lock = threading.Lock()
_attrs: dict[str, tuple[object, RoadAttrs]] = {}
"""incident -> (drill, attrs); the drill object identifies the cached graph."""
_grades: dict[str, tuple[object, dict[str, float], str]] = {}
_building: set[str] = set()
_failed_at: dict[str, float] = {}


def _cache_key(incident: str, way_ids: list[int]) -> str:
    digest = hashlib.sha1(",".join(map(str, way_ids)).encode()).hexdigest()[:16]
    return f"{TAGS_BUILDER}:{incident}:{digest}"


def _mongo_get(key: str) -> dict | None:
    try:
        doc = get_database()[dispatch_area.COLLECTION].find_one({"_id": key, "builder": TAGS_BUILDER})
    except dispatch_area._MONGO_ERRORS:
        logger.warning("drill road tags cache read failed")
        return None
    if not doc or not doc.get("gz"):
        return None
    try:
        return json.loads(gzip.decompress(bytes(doc["gz"])))
    except (OSError, ValueError):
        return None


def _mongo_put(key: str, value: dict) -> None:
    gz = gzip.compress(json.dumps(value, separators=(",", ":")).encode(), compresslevel=6, mtime=0)
    if len(gz) > dispatch_area.MAX_STORED_BYTES:
        return
    try:
        get_database()[dispatch_area.COLLECTION].replace_one(
            {"_id": key},
            {"_id": key, "builder": TAGS_BUILDER, "builtAt": datetime.now(UTC), "bytes": len(gz), "gz": Binary(gz)},
            upsert=True,
        )
    except dispatch_area._MONGO_ERRORS:
        logger.warning("drill road tags cache write failed; continuing without it")


def _ways_query(ids: list[int], date: str | None) -> str:
    when = f'[date:"{date}"]' if date else ""
    return f"[out:json][timeout:{dispatch_area.OVERPASS_QUERY_TIMEOUT_S}]{when};way(id:{','.join(map(str, ids))});out tags;"


def fetch_way_tags(way_ids: list[int], attic_date: str | None) -> dict:
    """{"ways": {id: tags}, "osm_timestamp", "attic_date", "attic_ways", "missing_ways"} from Overpass.

    Raises ``dispatch_area.UpstreamUnavailable`` when no mirror answers."""
    ways: dict[str, dict[str, str]] = {}
    stamp = None
    for i in range(0, len(way_ids), OVERPASS_IDS_PER_QUERY):
        data = dispatch_area.overpass(_ways_query(way_ids[i:i + OVERPASS_IDS_PER_QUERY], None))
        stamp = stamp or (data.get("osm3s") or {}).get("timestamp_osm_base")
        for el in data["elements"]:
            if el.get("type") == "way":
                tags = el.get("tags") or {}
                ways[str(el["id"])] = {k: str(tags[k]) for k in TAG_KEYS if k in tags}
    missing = [w for w in way_ids if str(w) not in ways]
    attic = 0
    if missing and attic_date:
        for i in range(0, len(missing), OVERPASS_IDS_PER_QUERY):
            data = dispatch_area.overpass(_ways_query(missing[i:i + OVERPASS_IDS_PER_QUERY], attic_date))
            for el in data["elements"]:
                if el.get("type") == "way" and str(el["id"]) not in ways:
                    tags = el.get("tags") or {}
                    ways[str(el["id"])] = {k: str(tags[k]) for k in TAG_KEYS if k in tags}
                    attic += 1
    return {
        "ways": ways,
        "osm_timestamp": stamp,
        "attic_date": attic_date,
        "attic_ways": attic,
        "missing_ways": len(way_ids) - len(ways),
        "way_count": len(way_ids),
        "fetchedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _camp_elevation():
    """(elevation lookup, source line) from the Camp package DEM, or (None, why)."""
    from .demo_realism import _repo_on_path, _terrain_package

    _repo_on_path()
    from sim.fire_obs import read_verified
    from sim.terrain import TERRAIN_PATH

    package = _terrain_package()
    try:
        raw = json.loads(read_verified(package, TERRAIN_PATH))
        values = raw["elevation_m"]
        ncols, nrows = int(raw["ncols"]), int(raw["nrows"])
        if len(values) != ncols * nrows or "south" not in str(raw.get("row_order", "")):
            raise ValueError("unexpected terrain grid layout")
        nodata = raw.get("nodata")
        if nodata is not None:
            values = [None if v == nodata else v for v in values]
        dlon = float(raw["cell_deg"])
        dlat = float(raw.get("cell_deg_lat", dlon))
        fn = bilinear(float(raw["origin_lon"]), float(raw["origin_lat"]), dlon, dlat, ncols, nrows, values)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("drill road grade: Camp DEM unavailable (%s)", exc)
        return None, f"no grade: the Camp DEM package is not available here ({type(exc).__name__}); 0% assumed"
    return fn, (f"grade: steepest {GRADE_WINDOW_M:g} m least-squares slope of the road's USGS 3DEP "
                f"{raw.get('source_resolution') or '1 arc-second'} ({raw.get('source_id')}) profile, sampled every "
                f"{GRADE_SAMPLE_M:g} m and median-filtered over +/-{GRADE_MEDIAN_HALF_M:g} m; bridges unknown "
                "(ASSUMPTION: an estimate that runs high on canyon-rim roads with coarse OSM geometry)")


def _grades_for(incident: str, drill) -> tuple[dict[str, float], str]:
    with _lock:
        hit = _grades.get(incident)
        if hit is not None and hit[0] is drill:
            return hit[1], hit[2]
    if incident == CAMP_INCIDENT_ID:
        elevation, source = _camp_elevation()
        grades = segment_grades(drill, elevation) if elevation is not None else {}
    else:
        grades, source = {}, "no grade: no DEM is wired for this incident; 0% assumed"
    with _lock:
        _grades[incident] = (drill, grades, source)
    return grades, source


def _compose(drill, tags_doc: dict | None, grades: dict[str, float], grade_source: str, way_count: int) -> RoadAttrs:
    if tags_doc is not None:
        way_tags = {int(k): v for k, v in (tags_doc.get("ways") or {}).items()}
        tags = segment_tags(drill, way_tags)
        attic = tags_doc.get("attic_ways") or 0
        tag_source = (
            f"OSM tags of {len(way_tags)}/{tags_doc.get('way_count') or way_count} drill ways by way id "
            f"(Overpass, OSM base {tags_doc.get('osm_timestamp') or 'unknown'}"
            + (f"; {attic} deleted since, tags as of {tags_doc.get('attic_date')}" if attic else "")
            + "); missing tags take the class defaults"
        )
        status = "ready"
    else:
        tags = {}
        tag_source = ("OSM tags not loaded yet (fetching, or Overpass unavailable); class defaults used" if way_count else
                      "no OSM way ids on this drill's roads; tags from the drill package where present")
        status = "grade_only" if grades else "none"
    basis = f"road access R01-R12: {tag_source}; {grade_source}; dead-end rule R10 not applied"
    return RoadAttrs(tags=tags, grade_pct=grades, basis=basis, status=status)


def _build_tags(incident: str, drill, key: str, way_ids: list[int]) -> None:
    try:
        doc = fetch_way_tags(way_ids, OSM_ATTIC_DATE.get(incident))
    except dispatch_area.UpstreamUnavailable:
        logger.warning("drill road tags: Overpass unavailable for %s", incident)
        doc = None
    except Exception:  # never let a background build crash the worker
        logger.exception("drill road tags build failed for %s", incident)
        doc = None
    try:
        if doc is None:
            with _lock:
                _failed_at[incident] = time.monotonic()
        else:
            _mongo_put(key, doc)
            grades, source = _grades_for(incident, drill)
            attrs = _compose(drill, doc, grades, source, len(way_ids))
            with _lock:
                _attrs[incident] = (drill, attrs)
    finally:
        with _lock:
            _building.discard(incident)


def get_road_attrs(incident: str, drill) -> RoadAttrs:
    """Tags and grade for ``drill``'s roads; never blocks on the network.

    Returns the cached attrs when the tags are loaded; otherwise starts (once) a background fetch
    and returns grade-only attrs (``status`` ``grade_only`` or ``none``)."""
    with _lock:
        hit = _attrs.get(incident)
        if hit is not None and hit[0] is drill and hit[1].status == "ready":
            return hit[1]
    way_ids = drill_way_ids(drill)
    grades, grade_source = _grades_for(incident, drill)
    if not way_ids:
        attrs = _compose(drill, None, grades, grade_source, 0)
        with _lock:
            _attrs[incident] = (drill, attrs)
        return attrs
    key = _cache_key(incident, way_ids)
    doc = _mongo_get(key)
    if doc is not None:
        attrs = _compose(drill, doc, grades, grade_source, len(way_ids))
        with _lock:
            _attrs[incident] = (drill, attrs)
        return attrs
    with _lock:
        hit = _attrs.get(incident)
        if hit is None or hit[0] is not drill:
            hit = (drill, _compose(drill, None, grades, grade_source, len(way_ids)))
            _attrs[incident] = hit
        recent_failure = time.monotonic() - _failed_at.get(incident, -1e9) < RETRY_AFTER_FAILURE_S
        start = incident not in _building and not recent_failure
        if start:
            _building.add(incident)
    if start:
        threading.Thread(target=_build_tags, args=(incident, drill, key, way_ids), daemon=True,
                         name=f"road-tags-{incident}").start()
    return hit[1]
