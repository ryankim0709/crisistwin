"""Geometry helpers on WGS84 ``(lon, lat)`` coordinates.

Small-area approximations are fine for one incident (tens of km): distances use haversine,
polygon distances use an equirectangular projection at the geometry's mean latitude.

Large polygons (zones of a few thousand vertices, fire fronts of about a thousand) are
"prepared" once and cached by identity: point-in-polygon uses latitude bands so a test only
looks at the ring segments that cross the point's band, and polygon distance uses a segment
grid with branch-and-bound pruning. Results are exact for the planar approximation.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TypeVar

LonLat = tuple[float, float]
"""``(lon, lat)`` in decimal degrees, the order used by GeoJSON, the sim and the bundle."""
Ring = tuple[LonLat, ...]
"""Closed ring (first point repeated last), exterior counter-clockwise not required."""
Polygon = tuple[Ring, ...]
"""Exterior ring first, then holes."""
MultiPolygon = tuple[Polygon, ...]
"""All areas are normalized to MultiPolygon; a GeoJSON Polygon becomes a 1-tuple."""

EARTH_RADIUS_M = 6_371_008.8

_KM_PER_DEG_LAT = math.pi * EARTH_RADIUS_M / 180.0 / 1000.0
_ON_EDGE_EPS = 1e-12
_CACHE_MAX = 128

T = TypeVar("T")


def haversine_m(a: LonLat, b: LonLat) -> float:
    """Great-circle distance between two points, in meters."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _point(value: Any) -> LonLat:
    if not isinstance(value, Sequence) or isinstance(value, str) or len(value) < 2:
        raise ValueError(f"malformed coordinate: {value!r}")
    try:
        lon, lat = float(value[0]), float(value[1])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"malformed coordinate: {value!r}") from exc
    if not (math.isfinite(lon) and math.isfinite(lat)) or abs(lon) > 180 or abs(lat) > 90:
        raise ValueError(f"coordinate out of range: {value!r}")
    return (lon, lat)


def _ring(value: Any) -> Ring:
    if not isinstance(value, Sequence) or isinstance(value, str):
        raise ValueError("malformed ring")
    points = [_point(p) for p in value]
    if points and points[0] != points[-1]:
        points.append(points[0])
    if len(points) < 4:
        raise ValueError("ring needs at least 3 distinct points")
    return tuple(points)


def _polygon(value: Any) -> Polygon:
    if not isinstance(value, Sequence) or isinstance(value, str) or not value:
        raise ValueError("malformed polygon")
    return tuple(_ring(r) for r in value)


def to_multipolygon(geometry: Mapping[str, Any]) -> MultiPolygon:
    """Convert a GeoJSON ``Polygon`` or ``MultiPolygon`` mapping to a ``MultiPolygon``.

    Raises ``ValueError`` for any other geometry type or malformed coordinates.
    """
    if not isinstance(geometry, Mapping):
        raise ValueError("geometry must be a mapping")
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Polygon":
        return (_polygon(coords),)
    if kind == "MultiPolygon":
        if not isinstance(coords, Sequence) or isinstance(coords, str) or not coords:
            raise ValueError("malformed MultiPolygon")
        return tuple(_polygon(p) for p in coords)
    raise ValueError(f"unsupported geometry type: {kind!r}")


def to_geojson(geometry: MultiPolygon) -> dict[str, Any]:
    """Render as a GeoJSON ``MultiPolygon`` mapping with ``[lon, lat]`` lists."""
    return {
        "type": "MultiPolygon",
        "coordinates": [[[[p[0], p[1]] for p in ring] for ring in polygon] for polygon in geometry],
    }


# --- prepared geometries (cached by identity) --------------------------------------------

_cache: dict[tuple[int, str, float], tuple[object, Any]] = {}


def _cached(geometry: MultiPolygon, kind: str, param: float, build: Callable[[], T]) -> T:
    key = (id(geometry), kind, param)
    hit = _cache.get(key)
    if hit is not None and hit[0] is geometry:
        return hit[1]
    value = build()
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(next(iter(_cache)))
    _cache[key] = (geometry, value)
    return value


class _BandedRing:
    """One ring's segments bucketed by latitude band for fast ray casting."""

    __slots__ = ("min_lat", "band_h", "bands", "bbox")

    def __init__(self, ring: Ring) -> None:
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        self.bbox = (min(lons), min(lats), max(lons), max(lats))
        n_bands = max(1, min(256, len(ring) // 4))
        self.min_lat = self.bbox[1]
        span = self.bbox[3] - self.bbox[1]
        self.band_h = span / n_bands if span > 0 else 1.0
        self.bands: list[list[tuple[float, float, float, float]]] = [[] for _ in range(n_bands)]
        for i in range(len(ring) - 1):
            (x1, y1), (x2, y2) = ring[i], ring[i + 1]
            seg = (x1, y1, x2, y2)
            for b in range(self._band(min(y1, y2)), self._band(max(y1, y2)) + 1):
                self.bands[b].append(seg)

    def _band(self, lat: float) -> int:
        b = int((lat - self.min_lat) / self.band_h)
        return min(max(b, 0), len(self.bands) - 1)

    def contains(self, x: float, y: float) -> bool | None:
        """True inside, False outside, None exactly on the boundary."""
        bx0, by0, bx1, by1 = self.bbox
        if x < bx0 or x > bx1 or y < by0 or y > by1:
            return False
        inside = False
        for x1, y1, x2, y2 in self.bands[self._band(y)]:
            if min(x1, x2) <= x <= max(x1, x2) and min(y1, y2) <= y <= max(y1, y2):
                if abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) <= _ON_EDGE_EPS:
                    return None
            if (y1 > y) != (y2 > y):
                xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                if x < xi:
                    inside = not inside
        return inside


_PreparedPip = list[tuple[tuple[float, float, float, float], list[_BandedRing]]]


def _prepare_pip(geometry: MultiPolygon) -> _PreparedPip:
    out: _PreparedPip = []
    for polygon in geometry:
        rings = [_BandedRing(r) for r in polygon]
        out.append((rings[0].bbox, rings))
    return out


def point_in_multipolygon(point: LonLat, geometry: MultiPolygon) -> bool:
    """Even-odd point-in-polygon test honoring holes; a point on an edge counts as inside."""
    prepared = _cached(geometry, "pip", 0.0, lambda: _prepare_pip(geometry))
    x, y = point[0], point[1]
    for (bx0, by0, bx1, by1), rings in prepared:
        if x < bx0 or x > bx1 or y < by0 or y > by1:
            continue
        outer = rings[0].contains(x, y)
        if outer is None:
            return True
        if not outer:
            continue
        in_hole = False
        for hole in rings[1:]:
            h = hole.contains(x, y)
            if h is None:
                return True
            if h:
                in_hole = True
                break
        if not in_hole:
            return True
    return False


def _ring_area_centroid(ring: Ring) -> tuple[float, float, float]:
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    a *= 0.5
    if a == 0:
        return 0.0, 0.0, 0.0
    return a, cx / (6 * a), cy / (6 * a)


def centroid(geometry: MultiPolygon) -> LonLat:
    """Area-weighted centroid of the exterior rings (planar, in degrees)."""
    total = sx = sy = 0.0
    for polygon in geometry:
        a, cx, cy = _ring_area_centroid(polygon[0])
        w = abs(a)
        total += w
        sx += cx * w
        sy += cy * w
    if total == 0:
        points = [p for polygon in geometry for p in polygon[0]]
        if not points:
            raise ValueError("empty geometry")
        return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    return (sx / total, sy / total)


# --- polygon distance (planar km) --------------------------------------------------------

_Seg = tuple[float, float, float, float]


class _SegGrid:
    """All ring segments of one area, projected to km, bucketed in a uniform grid."""

    __slots__ = ("segs", "vertices", "firsts", "x0", "y0", "cell", "nx", "ny", "grid", "bbox")

    def __init__(self, geometry: MultiPolygon, kx: float) -> None:
        ky = _KM_PER_DEG_LAT
        self.segs: list[_Seg] = []
        self.vertices: list[tuple[float, float]] = []
        self.firsts: list[LonLat] = []
        for polygon in geometry:
            for ring in polygon:
                self.firsts.append(ring[0])
                pts = [(p[0] * kx, p[1] * ky) for p in ring]
                self.vertices.extend(pts[:-1])
                for i in range(len(pts) - 1):
                    self.segs.append((pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]))
        xs = [v[0] for v in self.vertices]
        ys = [v[1] for v in self.vertices]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        w = self.bbox[2] - self.bbox[0]
        h = self.bbox[3] - self.bbox[1]
        self.cell = max(max(w, h) / 48.0, 0.02)
        self.x0, self.y0 = self.bbox[0], self.bbox[1]
        self.nx = int(w / self.cell) + 1
        self.ny = int(h / self.cell) + 1
        self.grid: dict[tuple[int, int], list[int]] = {}
        for i, (x1, y1, x2, y2) in enumerate(self.segs):
            for gx in range(self._ix(min(x1, x2)), self._ix(max(x1, x2)) + 1):
                for gy in range(self._iy(min(y1, y2)), self._iy(max(y1, y2)) + 1):
                    self.grid.setdefault((gx, gy), []).append(i)

    def _ix(self, x: float) -> int:
        return min(max(int((x - self.x0) / self.cell), 0), self.nx - 1)

    def _iy(self, y: float) -> int:
        return min(max(int((y - self.y0) / self.cell), 0), self.ny - 1)

    def candidates(self, x0: float, y0: float, x1: float, y1: float) -> set[int]:
        out: set[int] = set()
        if x1 < self.bbox[0] or x0 > self.bbox[2] or y1 < self.bbox[1] or y0 > self.bbox[3]:
            return out
        for gx in range(self._ix(x0), self._ix(x1) + 1):
            for gy in range(self._iy(y0), self._iy(y1) + 1):
                cell = self.grid.get((gx, gy))
                if cell:
                    out.update(cell)
        return out


def _point_seg_dist(px: float, py: float, s: _Seg) -> float:
    x1, y1, x2, y2 = s
    dx, dy = x2 - x1, y2 - y1
    d2 = dx * dx + dy * dy
    if d2 == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / d2
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _orient(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _segments_intersect(a: _Seg, b: _Seg) -> bool:
    d1 = _orient(b[0], b[1], b[2], b[3], a[0], a[1])
    d2 = _orient(b[0], b[1], b[2], b[3], a[2], a[3])
    d3 = _orient(a[0], a[1], a[2], a[3], b[0], b[1])
    d4 = _orient(a[0], a[1], a[2], a[3], b[2], b[3])
    if d1 * d2 < 0 and d3 * d4 < 0:
        return True
    if d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0:
        return False
    # Touching or collinear: decide by distance.
    return min(
        _point_seg_dist(a[0], a[1], b), _point_seg_dist(a[2], a[3], b),
        _point_seg_dist(b[0], b[1], a), _point_seg_dist(b[2], b[3], a),
    ) <= 1e-9


def _bbox_point_dist(bbox: tuple[float, float, float, float], x: float, y: float) -> float:
    dx = max(bbox[0] - x, 0.0, x - bbox[2])
    dy = max(bbox[1] - y, 0.0, y - bbox[3])
    return math.hypot(dx, dy)


def _directed_min(a: _SegGrid, b: _SegGrid, best: float) -> float:
    """Min distance from a's vertices to b's segments, pruned by ``best`` (branch and bound)."""
    order = sorted((_bbox_point_dist(b.bbox, x, y), x, y) for x, y in a.vertices)
    for lb, x, y in order:
        if lb >= best:
            break
        r = best
        for i in b.candidates(x - r, y - r, x + r, y + r):
            d = _point_seg_dist(x, y, b.segs[i])
            if d < best:
                best = d
    return best


def _kx(lat0: float) -> float:
    return _KM_PER_DEG_LAT * math.cos(math.radians(lat0))


def _grid(geometry: MultiPolygon, lat0: float) -> _SegGrid:
    return _cached(geometry, "grid", lat0, lambda: _SegGrid(geometry, _kx(lat0)))


def distance_km(a: MultiPolygon, b: MultiPolygon) -> float:
    """Minimum distance between two areas in km; 0.0 when they overlap or touch."""
    if not a or not b:
        raise ValueError("empty geometry")
    # One projection latitude per pair, rounded to 0.5 degree so cached grids are reused.
    lat0 = round((a[0][0][0][1] + b[0][0][0][1])) / 2
    ga, gb = _grid(a, lat0), _grid(b, lat0)
    # Boundaries crossing or touching -> 0.
    small, big = (ga, gb) if len(ga.segs) <= len(gb.segs) else (gb, ga)
    for s in small.segs:
        for i in big.candidates(min(s[0], s[2]), min(s[1], s[3]), max(s[0], s[2]), max(s[1], s[3])):
            if _segments_intersect(s, big.segs[i]):
                return 0.0
    # No crossings: an area lies inside the other iff its rings' first vertices do.
    if any(point_in_multipolygon(p, b) for p in ga.firsts):
        return 0.0
    if any(point_in_multipolygon(p, a) for p in gb.firsts):
        return 0.0
    va, vb = ga.vertices[0], gb.vertices[0]
    best = math.hypot(va[0] - vb[0], va[1] - vb[1])
    best = _directed_min(ga, gb, best)
    best = _directed_min(gb, ga, best)
    return best


def _seg_seg_dist(a: _Seg, b: _Seg) -> float:
    if _segments_intersect(a, b):
        return 0.0
    return min(
        _point_seg_dist(a[0], a[1], b), _point_seg_dist(a[2], a[3], b),
        _point_seg_dist(b[0], b[1], a), _point_seg_dist(b[2], b[3], a),
    )


def polyline_distance_m(line: Sequence[LonLat], geometry: MultiPolygon, max_m: float) -> float:
    """Planar distance in meters from a polyline to an area; 0.0 when any part of the line
    lies inside the area or crosses its boundary, ``math.inf`` when farther than ``max_m``.

    Uses the area's cached segment grid (equirectangular at the area's latitude) with a bbox
    prefilter on the whole line, then per line segment on nearby boundary segments only.
    """
    if not line or not geometry:
        return math.inf
    lat0 = round(geometry[0][0][0][1] * 2) / 2
    g = _grid(geometry, lat0)
    kx, ky = _kx(lat0), _KM_PER_DEG_LAT
    r = max_m / 1000.0
    pts = [(p[0] * kx, p[1] * ky) for p in line]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    bx0, by0, bx1, by1 = g.bbox
    if min(xs) > bx1 + r or max(xs) < bx0 - r or min(ys) > by1 + r or max(ys) < by0 - r:
        return math.inf
    if any(point_in_multipolygon(p, geometry) for p in line):
        return 0.0
    near = [g.segs[j] for j in g.candidates(min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r)]
    if not near:
        return math.inf
    best = math.inf
    if len(pts) == 1:
        pts = pts * 2
    for i in range(len(pts) - 1):
        s = (pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        sx0, sx1 = min(s[0], s[2]) - r, max(s[0], s[2]) + r
        sy0, sy1 = min(s[1], s[3]) - r, max(s[1], s[3]) + r
        for b in near:
            if max(b[0], b[2]) < sx0 or min(b[0], b[2]) > sx1 or max(b[1], b[3]) < sy0 or min(b[1], b[3]) > sy1:
                continue
            d = _seg_seg_dist(s, b)
            if d < best:
                best = d
                if best == 0.0:
                    return 0.0
    best_m = best * 1000.0
    return best_m if best_m <= max_m else math.inf


def simplify_line(line: Sequence[LonLat], tolerance_m: float, max_points: int) -> tuple[LonLat, ...]:
    """Douglas-Peucker simplification (equirectangular at the line's first latitude), keeping
    both ends; then evenly thinned to at most ``max_points`` (>= 2) if still longer."""
    pts = list(line)
    if len(pts) <= 2:
        return tuple(pts)
    kx, ky = _kx(pts[0][1]) * 1000.0, _KM_PER_DEG_LAT * 1000.0
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        (ax, ay), (bx, by) = xy[i], xy[j]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_k = -1.0, -1
        for k in range(i + 1, j):
            px, py = xy[k]
            d = (abs(dy * (px - ax) - dx * (py - ay)) / norm) if norm > 0 else math.hypot(px - ax, py - ay)
            if d > best:
                best, best_k = d, k
        if best > tolerance_m:
            keep[best_k] = True
            stack.append((i, best_k))
            stack.append((best_k, j))
    out = [p for p, k in zip(pts, keep) if k]
    if len(out) > max(2, max_points):
        n = max(2, max_points)
        step = (len(out) - 1) / (n - 1)
        out = [out[round(i * step)] for i in range(n)]
    return tuple(out)
