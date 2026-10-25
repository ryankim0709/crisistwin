"""Per-edge OSM access tags and terrain grade for a drill road graph (docs/command-demo-realism.md
"Road access").

The drill bundles keep only ``highway``, ``lanes``, ``bridge`` and speed per edge, so the road access
rules R01-R12 (docs/suppression-data.md) cannot close anything on them. ``RoadAttrs`` adds what the
rules read: the way's OSM tags (surface, tracktype, smoothness, width, maxweight, maxheight, bridge,
access, emergency, motor_vehicle, 4wd_only) matched by OSM way id, and the steepest windowed grade
of each segment from an elevation model. ``livecore.apparatus.access_profile`` merges them over
the edge's own tags. Fetching and caching live in ``api.drill_road_attrs``; this module is pure.

Units: grade percent (absolute), metres, WGS84 ``(lon, lat)``.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from .drill import Drill
from .geo import LonLat, haversine_m

ATTR_TAG_KEYS = (
    "surface", "tracktype", "smoothness", "width", "maxweight", "maxheight", "bridge", "access",
    "emergency", "motor_vehicle", "4wd_only",
)
"""OSM tags taken from the fetched way. ``highway``, ``maxspeed``, ``lanes`` and ``oneway`` stay the
drill's own (the graph the drill was built from). ``4wd_only`` is carried for display; no rule of
R01-R12 reads it."""

GRADE_WINDOW_M = 150.0
"""ASSUMPTION (not sourced): grade is the steepest least-squares slope of the along-road elevation
profile over windows of this many ground metres; shorter edges use their full length. Longer than
app/src/studio/roadAccess.ts GRADE_WINDOW_METERS (100 m, endpoint difference): on Camp the 30 m DEM
under coarse 2018 OSM geometry (few vertices, cutting across switchbacks and canyon rims) gave
about 460 km of drill road above 16% that way, against about 340 km here. Still an estimate that
runs high on canyon-rim roads; calibrate against surveyed grades."""
GRADE_MEDIAN_HALF_M = 50.0
"""The profile is first median-filtered over +/- this many metres (drops single-cell DEM spikes)."""
GRADE_SAMPLE_M = 10.0
"""Sample spacing along the edge for the bilinear DEM lookups (roadAccess.ts GRADE_SAMPLE_SPACING_METERS)."""

_WAY_ID = re.compile(r"^osm-way:(\d+):")

Elevation = Callable[[float, float], "float | None"]
"""(lon, lat) -> metres, or None off the model."""


@dataclass(frozen=True)
class RoadAttrs:
    """Tags and grade per drill segment (both directions of a road share a segment)."""

    tags: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    """Segment id -> OSM tags (only ATTR_TAG_KEYS)."""
    grade_pct: Mapping[str, float] = field(default_factory=dict)
    """Segment id -> steepest windowed grade, percent; missing = unknown (0% assumed by the rules)."""
    basis: str = ""
    """One line: where the tags and grades come from, and what is assumed."""
    status: str = "none"
    """``ready`` (tags and grade), ``grade_only`` (tags still loading or unavailable), ``none``."""
    elevation: "Elevation | None" = field(default=None, compare=False)
    """(lon, lat) -> metres, the DEM the grades came from; the travel-time model
    (``livecore.apparatus_travel``) samples signed profiles from it. None: no DEM (flat assumed)."""


def way_id(edge_id: str) -> int | None:
    """OSM way id of a camp-2018 style edge id ``osm-way:<id>:<n>:<f|r>``; None otherwise."""
    m = _WAY_ID.match(edge_id)
    return int(m.group(1)) if m else None


def drill_way_ids(drill: Drill) -> list[int]:
    """Sorted unique OSM way ids of the drill's edges (empty for synthetic ids)."""
    return sorted({w for eid in drill.roads.edges if (w := way_id(eid)) is not None})


def segment_tags(drill: Drill, way_tags: Mapping[int, Mapping[str, str]]) -> dict[str, dict[str, str]]:
    """Segment id -> the ATTR_TAG_KEYS subset of its way's tags (segments with any)."""
    out: dict[str, dict[str, str]] = {}
    for eid, edge in drill.roads.edges.items():
        if edge.segment_id in out:
            continue
        w = way_id(eid)
        tags = way_tags.get(w) if w is not None else None
        if not tags:
            continue
        kept = {k: str(tags[k]) for k in ATTR_TAG_KEYS if tags.get(k) not in (None, "")}
        if kept:
            out[edge.segment_id] = kept
    return out


def _median_filter(distance: Sequence[float], height: Sequence[float], half: float) -> list[float]:
    out: list[float] = []
    n = len(distance)
    lo = hi = 0
    for i in range(n):
        while distance[i] - distance[lo] > half:
            lo += 1
        while hi < n - 1 and distance[hi + 1] - distance[i] <= half:
            hi += 1
        out.append(statistics.median(height[lo:hi + 1]))
    return out


def polyline_grade_pct(coords: Sequence[LonLat], elevation: Elevation) -> float | None:
    """Steepest windowed grade along a polyline, percent; None when any sample is off the model.

    Samples the DEM every GRADE_SAMPLE_M, median-filters the profile over +/-GRADE_MEDIAN_HALF_M,
    then takes the steepest least-squares slope over runs of GRADE_WINDOW_M (the whole line when
    shorter). Prefix sums keep each window O(1)."""
    if len(coords) < 2:
        return 0.0
    first = elevation(coords[0][0], coords[0][1])
    if first is None:
        return None
    distance = [0.0]
    height = [first]
    along = 0.0
    for a, b in zip(coords, coords[1:], strict=False):
        length = haversine_m(a, b)
        steps = max(1, int(-(-length // GRADE_SAMPLE_M)))
        for s in range(1, steps + 1):
            t = s / steps
            z = elevation(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            if z is None:
                return None
            distance.append(along + length * t)
            height.append(z)
        along += length
    if along <= 0:
        return 0.0
    h = _median_filter(distance, height, GRADE_MEDIAN_HALF_M)
    n = len(distance)
    sx, sy, sxx, sxy = [0.0], [0.0], [0.0], [0.0]
    for x, y in zip(distance, h, strict=True):
        sx.append(sx[-1] + x)
        sy.append(sy[-1] + y)
        sxx.append(sxx[-1] + x * x)
        sxy.append(sxy[-1] + x * y)

    def slope(i: int, j: int) -> float:
        """Least-squares slope of samples i..j inclusive."""
        m = j - i + 1
        x, y = sx[j + 1] - sx[i], sy[j + 1] - sy[i]
        xx, xy = sxx[j + 1] - sxx[i], sxy[j + 1] - sxy[i]
        den = m * xx - x * x
        return 0.0 if den <= 1e-9 else (m * xy - x * y) / den

    window = min(GRADE_WINDOW_M, along)
    steepest = 0.0
    j = 0
    for i in range(n):
        while j < n - 1 and distance[j] - distance[i] < window - 1e-6:
            j += 1
        if distance[j] - distance[i] < window - 1e-6:
            break
        steepest = max(steepest, abs(slope(i, j)) * 100)
    return steepest


def segment_grades(drill: Drill, elevation: Elevation) -> dict[str, float]:
    """Segment id -> grade percent (rounded to 0.1) for segments fully on the elevation model.

    Bridges are skipped (the DEM under a bridge is the gap it spans): their grade stays unknown."""
    out: dict[str, float] = {}
    seen: set[str] = set()
    for edge in drill.roads.edges.values():
        if edge.segment_id in seen:
            continue
        seen.add(edge.segment_id)
        if edge.bridge or dict(edge.tags).get("bridge") not in (None, "no") or dict(edge.tags).get("tunnel") not in (None, "no"):
            continue
        g = polyline_grade_pct(edge.coords, elevation)
        if g is not None:
            out[edge.segment_id] = round(g, 1)
    return out


def bilinear(origin_lon: float, origin_lat: float, dlon: float, dlat: float, ncols: int, nrows: int,
             values: Sequence[float | int | None]) -> Elevation:
    """Bilinear lookup on a regular lon/lat grid of cell values (row 0 = south, origin at the
    south-west corner of cell (0, 0), values at cell centres); None outside or on a missing cell."""

    def at(lon: float, lat: float) -> float | None:
        fx = (lon - origin_lon) / dlon - 0.5
        fy = (lat - origin_lat) / dlat - 0.5
        if fx < 0 or fy < 0 or fx > ncols - 1 or fy > nrows - 1:
            return None
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(ncols - 1, x0 + 1), min(nrows - 1, y0 + 1)
        tx, ty = fx - x0, fy - y0
        a, b = values[y0 * ncols + x0], values[y0 * ncols + x1]
        c, d = values[y1 * ncols + x0], values[y1 * ncols + x1]
        if a is None or b is None or c is None or d is None:
            return None
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty

    return at
