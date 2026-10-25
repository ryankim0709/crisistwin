"""Studio scenario -> drill package: any California Studio fire as a live drill.

Contract: docs/replay-bundle.md "Drill packages"; decision: docs/adr/0037-studio-drill-packages.md.

Pure (stdlib only, no Django, network or storage). Two inputs:

- a **Studio run export** (``kind: "crisistwin_studio_run"``, built by the web client from a
  finished Simulation Studio run): the fire arrival grid in Web Mercator (EPSG:3857), the
  frame perimeters in WGS84 ``[lon, lat]``, the ignitions, the ignition time (drill T+0) and the
  wind and moisture assumptions;
- a **dispatch area** (``GET /api/dispatch/area`` schema v2) built for the box ``area_box``
  returns: OSM roads, fire stations, synthetic homes grouped into zones, exits.

``build_package`` returns a replay-bundle-compatible document that ``livecore.drill.load_drill``
reads: zones (synthetic), roads, destinations (exits), a separate ``stations`` layer, the
simulated fire as ``fire_simulated.fronts`` (plus a resampled ``arrival_grid``), no perimeters,
no observations and no events. Every layer keeps its label: assumed wind and moisture,
synthetic homes and zones, simulated fire.

Units and order: coordinates ``[lon, lat]`` WGS84 decimal degrees; times UTC ISO 8601 ``Z``;
arrival seconds after T+0; wind open 20-ft mph, bearing the wind blows FROM (degrees true).
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .drill import Drill, load_drill, parse_time
from .geo import to_geojson, to_multipolygon

RUN_KIND = "crisistwin_studio_run"
RUN_SCHEMA_VERSION = 1
PACKAGE_KIND = "crisistwin_drill_package"
PACKAGE_VERSION = 1
BUILDER = "studio-drill-package/1"
AREA_KIND = "crisistwin_dispatch_area"
AREA_SCHEMA_VERSION = 2

# Input limits (strict validation).
MAX_GRID_CELLS = 1_500_000
MAX_FRAMES = 200
MAX_FRAME_VERTICES = 400_000
MAX_IGNITIONS = 5
MAX_NAME_LEN = 80
HORIZON_CHOICES_MIN = (60, 120, 180, 360)
"""Studio's ``STUDIO_HORIZON_CHOICES``."""
MAX_WIND_MPH = 60.0
MAX_MOISTURE_FRACTION = 3.0
MERCATOR_RADIUS_M = 6_378_137.0
"""EPSG:3857 sphere radius; matches ``EARTH_CIRCUMFERENCE_METERS / 2pi`` in fire/landscape.ts."""
MERCATOR_MAX_ABS_M = math.pi * MERCATOR_RADIUS_M
IGNITION_YEAR_RANGE = (2000, 2100)

# Package construction.
AREA_PAD_M = 3000.0
"""Road box = reached cells and ignitions grown by this many metres on every side."""
AREA_MAX_LON_SPAN_DEG = 0.26
AREA_MAX_LAT_SPAN_DEG = 0.20
"""Below ``dispatch_area.MAX_LON_SPAN_DEG`` / ``MAX_LAT_SPAN_DEG`` (0.28 x 0.22) so the 0.01 deg
outward snap still fits; a larger fire is centred and the rest of it lies outside the roads."""
CLOCK_TAIL_MIN = 120
"""Drill clock runs this long past the fire horizon (the last front holds; evacuation goes on)."""
ARRIVAL_GRID_MIN_CELL_M = 100.0
"""The package's ``arrival_grid`` resamples the Studio grid to cells at least this large."""
MIN_ZONE_HALF_M = 60.0
"""A zone whose synthetic homes span fewer than three hull points becomes a square this half-size."""
TIMEZONE = "America/Los_Angeles"

M_PER_DEG_LAT = 111_195.08
"""Mean metres per degree of latitude (sphere R = 6,371,008.8 m), as ``geo.haversine_m``."""

CA_POLYGON: tuple[tuple[float, float], ...] = (
    (-124.45, 42.00), (-120.00, 42.00), (-120.00, 39.00), (-114.63, 35.00), (-114.57, 34.80),
    (-114.13, 34.30), (-114.43, 34.08), (-114.53, 33.03), (-114.72, 32.72), (-117.12, 32.53),
    (-117.35, 32.55), (-118.60, 33.35), (-120.70, 34.40), (-121.00, 35.30), (-122.00, 36.45),
    (-122.60, 37.15), (-123.10, 37.90), (-123.85, 38.90), (-124.50, 40.30), (-124.35, 41.50),
)
"""Simplified California outline, ``(lon, lat)``: state lines on land (42 N, 120 W, the oblique
line to the Colorado River, the river, the Mexican border) and a seaward coastline a few km
offshore. Accurate to a few km; the Channel and Farallon islands are outside it."""


class PackageError(ValueError):
    """Invalid input. ``code`` is the API error code, ``detail`` safe to show."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _bad(detail: str) -> PackageError:
    return PackageError("invalid_run", detail)


# --- California ---------------------------------------------------------------------------


def in_california(lon: float, lat: float) -> bool:
    """Point-in-polygon on ``CA_POLYGON`` (even-odd ray cast in degrees)."""
    inside = False
    n = len(CA_POLYGON)
    for i in range(n):
        x1, y1 = CA_POLYGON[i]
        x2, y2 = CA_POLYGON[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < x:
                inside = not inside
    return inside


# --- Studio run ---------------------------------------------------------------------------


def mercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """EPSG:3857 metres -> WGS84 ``(lon, lat)`` degrees."""
    lon = math.degrees(x / MERCATOR_RADIUS_M)
    lat = math.degrees(2 * math.atan(math.exp(y / MERCATOR_RADIUS_M)) - math.pi / 2)
    return lon, lat


def lonlat_to_mercator(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * MERCATOR_RADIUS_M
    y = MERCATOR_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


@dataclass(frozen=True)
class ArrivalGrid:
    """Studio's combined arrival grid. Cell ``(col, row)`` has its centre at Mercator
    ``(origin_x + col * cell_x, origin_y + row * cell_y)``; ``cell_y`` < 0 (row 0 is north).
    ``arrival_s`` is row-major (``row * ncols + col``), seconds after T+0, None = not reached."""

    origin_x: float
    origin_y: float
    cell_x: float
    cell_y: float
    ncols: int
    nrows: int
    ground_cell_m: float
    arrival_s: tuple[int | None, ...]

    def cell_lonlat(self, col: float, row: float) -> tuple[float, float]:
        return mercator_to_lonlat(self.origin_x + col * self.cell_x, self.origin_y + row * self.cell_y)

    def at(self, lon: float, lat: float) -> int | None:
        """Arrival seconds at a point, None when unreached or off the grid."""
        x, y = lonlat_to_mercator(lon, lat)
        col = round((x - self.origin_x) / self.cell_x)
        row = round((y - self.origin_y) / self.cell_y)
        if not (0 <= col < self.ncols and 0 <= row < self.nrows):
            return None
        return self.arrival_s[row * self.ncols + col]

    def extent(self) -> tuple[float, float, float, float]:
        """Outer edges ``(west, south, east, north)`` in degrees."""
        w, n = self.cell_lonlat(-0.5, -0.5)
        e, s = self.cell_lonlat(self.ncols - 0.5, self.nrows - 0.5)
        return w, s, e, n

    def reached_extent(self) -> tuple[float, float, float, float] | None:
        """Outer edges of reached cells, or None when nothing burned."""
        cols: list[int] = []
        rows: list[int] = []
        for i, value in enumerate(self.arrival_s):
            if value is not None:
                rows.append(i // self.ncols)
                cols.append(i % self.ncols)
        if not cols:
            return None
        w, n = self.cell_lonlat(min(cols) - 0.5, min(rows) - 0.5)
        e, s = self.cell_lonlat(max(cols) + 0.5, max(rows) + 0.5)
        return w, s, e, n


@dataclass(frozen=True)
class Ignition:
    id: str
    name: str
    coord: tuple[float, float]
    """``(lon, lat)``."""
    start_minute: int


@dataclass(frozen=True)
class Frame:
    minute: int
    geometry: Any
    """A ``geo.MultiPolygon`` (``(lon, lat)``), or None for an empty frame."""
    area_m2: float | None


@dataclass(frozen=True)
class StudioRun:
    scenario_id: str
    name: str
    region_id: str | None
    ignition_time: datetime
    """Drill T+0 (UTC). Chosen by the user, not observed."""
    ignitions: tuple[Ignition, ...]
    wind_20ft_mph: float
    wind_from_deg: float
    moisture: Mapping[str, float]
    midflame_adjustment: float
    horizon_min: int
    spotting: Mapping[str, Any] | None
    structure_spread: Mapping[str, Any] | None
    model: Mapping[str, Any]
    landscape: Mapping[str, Any]
    grid: ArrivalGrid
    frames: tuple[Frame, ...]


def _num(value: Any, field: str, lo: float | None = None, hi: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _bad(f"`{field}` must be a finite number.")
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        raise _bad(f"`{field}` must be between {lo} and {hi}.")
    return float(value)


def _int(value: Any, field: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise _bad(f"`{field}` must be an integer from {lo} to {hi}.")
    return value


def _str(value: Any, field: str, max_len: int = MAX_NAME_LEN, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise _bad(f"`{field}` must be a non-empty string of at most {max_len} characters.")
    return value.strip()


def _obj(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _bad(f"`{field}` must be an object.")
    return value


def _lonlat(value: Any, field: str) -> tuple[float, float]:
    if not isinstance(value, Sequence) or isinstance(value, str) or len(value) != 2:
        raise _bad(f"`{field}` must be [lon, lat].")
    return _num(value[0], f"{field}[0] (lon)", -180, 180), _num(value[1], f"{field}[1] (lat)", -90, 90)


def _parse_grid(raw: Any) -> ArrivalGrid:
    g = _obj(raw, "arrival_grid")
    if g.get("crs") != "EPSG:3857":
        raise _bad("`arrival_grid.crs` must be \"EPSG:3857\" (Web Mercator metres).")
    if g.get("order") != "row_major_north_first":
        raise _bad("`arrival_grid.order` must be \"row_major_north_first\".")
    ncols = _int(g.get("ncols"), "arrival_grid.ncols", 1, 100_000)
    nrows = _int(g.get("nrows"), "arrival_grid.nrows", 1, 100_000)
    if ncols * nrows > MAX_GRID_CELLS:
        raise _bad(f"`arrival_grid` has {ncols * nrows} cells; at most {MAX_GRID_CELLS}.")
    origin_x = _num(g.get("origin_x"), "arrival_grid.origin_x", -MERCATOR_MAX_ABS_M, MERCATOR_MAX_ABS_M)
    origin_y = _num(g.get("origin_y"), "arrival_grid.origin_y", -MERCATOR_MAX_ABS_M, MERCATOR_MAX_ABS_M)
    cell_x = _num(g.get("cell_x"), "arrival_grid.cell_x", 1, 5000)
    cell_y = _num(g.get("cell_y"), "arrival_grid.cell_y", -5000, -1)
    ground = _num(g.get("ground_cell_m"), "arrival_grid.ground_cell_m", 1, 5000)
    values = g.get("arrival_s")
    if not isinstance(values, list) or len(values) != ncols * nrows:
        raise _bad("`arrival_grid.arrival_s` must be a list of ncols * nrows values.")
    out: list[int | None] = []
    for v in values:
        if v is None:
            out.append(None)
        elif isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 86_400:
            out.append(v)
        else:
            raise _bad("`arrival_grid.arrival_s` values must be integer seconds 0..86400 or null.")
    return ArrivalGrid(origin_x, origin_y, cell_x, cell_y, ncols, nrows, ground, tuple(out))


def parse_run(raw: Any) -> StudioRun:
    """Validate a Studio run export strictly. Raises ``PackageError``."""
    r = _obj(raw, "run")
    if r.get("kind") != RUN_KIND:
        raise _bad(f"`kind` must be \"{RUN_KIND}\".")
    if r.get("schema_version") != RUN_SCHEMA_VERSION:
        raise _bad(f"`schema_version` must be {RUN_SCHEMA_VERSION}.")
    scenario = _obj(r.get("scenario"), "scenario")
    scenario_id = _str(scenario.get("id"), "scenario.id", 100)
    name = _str(scenario.get("name"), "scenario.name")
    region_id = _str(r.get("region_id"), "region_id", 100, optional=True)
    try:
        ignition_time = parse_time(r.get("ignition_time"))
    except ValueError as exc:
        raise _bad("`ignition_time` must be an ISO 8601 UTC time with Z.") from exc
    if not IGNITION_YEAR_RANGE[0] <= ignition_time.year <= IGNITION_YEAR_RANGE[1]:
        raise _bad("`ignition_time` is out of range.")

    a = _obj(r.get("assumptions"), "assumptions")
    wind = _num(a.get("wind_20ft_mph"), "assumptions.wind_20ft_mph", 0, MAX_WIND_MPH)
    wind_from = _num(a.get("wind_from_deg"), "assumptions.wind_from_deg", 0, 360)
    moisture_raw = _obj(a.get("moisture"), "assumptions.moisture")
    moisture = {}
    for key in ("dead1h", "dead10h", "dead100h", "liveHerb", "liveWoody"):
        moisture[key] = _num(moisture_raw.get(key), f"assumptions.moisture.{key}", 0.01, MAX_MOISTURE_FRACTION)
    midflame = _num(a.get("midflame_adjustment"), "assumptions.midflame_adjustment", 0.01, 1)
    horizon = a.get("horizon_min")
    if horizon not in HORIZON_CHOICES_MIN or isinstance(horizon, bool):
        raise _bad(f"`assumptions.horizon_min` must be one of {HORIZON_CHOICES_MIN}.")
    spotting = a.get("spotting")
    structure = a.get("structure_spread")
    for key, value in (("spotting", spotting), ("structure_spread", structure)):
        if value is not None and not isinstance(value, Mapping):
            raise _bad(f"`assumptions.{key}` must be an object or null.")

    raw_ignitions = r.get("ignitions")
    if not isinstance(raw_ignitions, list) or not 1 <= len(raw_ignitions) <= MAX_IGNITIONS:
        raise _bad(f"`ignitions` must list 1 to {MAX_IGNITIONS} enabled ignitions.")
    ignitions = []
    seen: set[str] = set()
    for i, item in enumerate(raw_ignitions):
        it = _obj(item, f"ignitions[{i}]")
        ig_id = _str(it.get("id"), f"ignitions[{i}].id", 100)
        if ig_id in seen:
            raise _bad("`ignitions` ids must be unique.")
        seen.add(ig_id)
        ignitions.append(Ignition(
            id=ig_id,
            name=_str(it.get("name"), f"ignitions[{i}].name"),
            coord=_lonlat(it.get("coord"), f"ignitions[{i}].coord"),
            start_minute=_int(it.get("start_minute"), f"ignitions[{i}].start_minute", 0, horizon - 1),
        ))

    model = _obj(r.get("model"), "model")
    _str(model.get("id"), "model.id", 100)
    landscape = _obj(r.get("landscape") or {}, "landscape")
    grid = _parse_grid(r.get("arrival_grid"))
    if max((v for v in grid.arrival_s if v is not None), default=0) > horizon * 60:
        raise _bad("`arrival_grid.arrival_s` holds an arrival after the horizon.")

    west, south, east, north = grid.extent()
    tol_lon = (east - west) * 0.01
    tol_lat = (north - south) * 0.01
    for ig in ignitions:
        lon, lat = ig.coord
        if not (west <= lon <= east and south <= lat <= north):
            raise _bad(f"Ignition {ig.name} is outside the arrival grid.")

    raw_frames = r.get("frames")
    if not isinstance(raw_frames, list) or not 1 <= len(raw_frames) <= MAX_FRAMES:
        raise _bad(f"`frames` must list 1 to {MAX_FRAMES} frames.")
    frames: list[Frame] = []
    vertices = 0
    last = -1
    for i, item in enumerate(raw_frames):
        f = _obj(item, f"frames[{i}]")
        minute = _int(f.get("minute"), f"frames[{i}].minute", 0, horizon)
        if minute <= last:
            raise _bad("`frames` minutes must be strictly ascending.")
        last = minute
        area = f.get("area_m2")
        area_m2 = None if area is None else _num(area, f"frames[{i}].area_m2", 0, 1e11)
        geom_raw = f.get("geometry")
        geometry = None
        if geom_raw is not None:
            try:
                geometry = to_multipolygon(geom_raw)
            except ValueError as exc:
                raise _bad(f"`frames[{i}].geometry` is not a valid Polygon or MultiPolygon: {exc}") from exc
            for polygon in geometry:
                for ring in polygon:
                    vertices += len(ring)
                    for lon, lat in ring:
                        if not (west - tol_lon <= lon <= east + tol_lon and south - tol_lat <= lat <= north + tol_lat):
                            raise _bad(f"`frames[{i}].geometry` lies outside the arrival grid ([lon, lat] order?).")
            if vertices > MAX_FRAME_VERTICES:
                raise _bad(f"`frames` hold more than {MAX_FRAME_VERTICES} vertices.")
        frames.append(Frame(minute, geometry, area_m2))
    if not any(f.geometry is not None for f in frames):
        raise _bad("The run has no fire area in any frame.")
    if grid.reached_extent() is None:
        raise _bad("The arrival grid has no reached cells.")

    return StudioRun(
        scenario_id=scenario_id, name=name, region_id=region_id, ignition_time=ignition_time,
        ignitions=tuple(ignitions), wind_20ft_mph=wind, wind_from_deg=wind_from, moisture=moisture,
        midflame_adjustment=midflame, horizon_min=horizon, spotting=spotting, structure_spread=structure,
        model=dict(model), landscape=dict(landscape), grid=grid, frames=tuple(frames),
    )


# --- road box -----------------------------------------------------------------------------


@dataclass(frozen=True)
class AreaBox:
    bbox: tuple[float, float, float, float]
    """``(west, south, east, north)`` degrees, before the dispatch area's 0.01 deg snap."""
    clipped: bool
    """True when the fire plus padding was larger than the dispatch area allows."""


def area_box(run: StudioRun) -> AreaBox:
    """The box to request ``/api/dispatch/area`` for: reached cells and ignitions plus
    ``AREA_PAD_M``, centred and cut to ``AREA_MAX_*_SPAN_DEG``. Raises ``PackageError``
    (``outside_california``) unless the box centre and every ignition lie in ``CA_POLYGON``."""
    for ig in run.ignitions:
        if not in_california(*ig.coord):
            raise PackageError("outside_california", f"Ignition {ig.name} is outside California.")
    reached = run.grid.reached_extent()
    assert reached is not None  # parse_run guarantees it
    w, s, e, n = reached
    for lon, lat in (ig.coord for ig in run.ignitions):
        w, s, e, n = min(w, lon), min(s, lat), max(e, lon), max(n, lat)
    lat0 = (s + n) / 2
    pad_lat = AREA_PAD_M / M_PER_DEG_LAT
    pad_lon = AREA_PAD_M / (M_PER_DEG_LAT * math.cos(math.radians(lat0)))
    w, s, e, n = w - pad_lon, s - pad_lat, e + pad_lon, n + pad_lat
    cx, cy = (w + e) / 2, (s + n) / 2
    if not in_california(cx, cy):
        raise PackageError("outside_california", "The fire's area is outside California.")
    half_lon = min((e - w) / 2, AREA_MAX_LON_SPAN_DEG / 2)
    half_lat = min((n - s) / 2, AREA_MAX_LAT_SPAN_DEG / 2)
    clipped = half_lon < (e - w) / 2 or half_lat < (n - s) / 2
    box = (round(cx - half_lon, 6), round(cy - half_lat, 6), round(cx + half_lon, 6), round(cy + half_lat, 6))
    return AreaBox(box, clipped)


# --- dispatch area ------------------------------------------------------------------------


def _check_area(area: Any) -> Mapping[str, Any]:
    def bad(detail: str) -> PackageError:
        return PackageError("invalid_area", f"Dispatch area: {detail}")

    if not isinstance(area, Mapping) or area.get("kind") != AREA_KIND:
        raise bad(f"kind must be {AREA_KIND}.")
    if area.get("schemaVersion") != AREA_SCHEMA_VERSION:
        raise bad(f"schemaVersion must be {AREA_SCHEMA_VERSION}.")
    nodes = area.get("nodes")
    edges = area.get("edges")
    if not isinstance(nodes, list) or not nodes or not isinstance(edges, list) or not edges:
        raise bad("nodes and edges must be non-empty lists.")
    for node in nodes:
        if not (isinstance(node, list) and len(node) == 2 and all(isinstance(v, (int, float)) for v in node)
                and -180 <= node[0] <= 180 and -90 <= node[1] <= 90):
            raise bad("each node must be [lon, lat].")
    for edge in edges:
        if not (isinstance(edge, list) and len(edge) >= 9):
            raise bad("each edge must be a v2 edge row.")
        a, b, length, cls, kph, cap, _oneway, _name, geom = edge[:9]
        if not (isinstance(a, int) and isinstance(b, int) and 0 <= a < len(nodes) and 0 <= b < len(nodes)):
            raise bad("edge node index out of range.")
        if not (isinstance(length, (int, float)) and length >= 0 and isinstance(kph, (int, float)) and kph > 0):
            raise bad("edge length must be >= 0 m and speed > 0 kph.")
        if not (isinstance(cls, int) and 0 <= cls < len(area.get("classes") or [])):
            raise bad("edge class index out of range.")
        if not (isinstance(cap, (int, float)) and cap >= 0) or not isinstance(geom, list) or len(geom) % 2:
            raise bad("edge capacity or geometry is malformed.")
    if not isinstance(area.get("zones"), list) or not area["zones"]:
        raise PackageError("no_homes", "No residential streets were found in this area, so there are no zones.")
    for zone in area["zones"]:
        if not (isinstance(zone, Mapping) and isinstance(zone.get("polygon"), list)
                and isinstance(zone.get("homes"), int) and zone["homes"] >= 0
                and isinstance(zone.get("vehicles"), int) and zone["vehicles"] >= 0):
            raise bad("each zone needs a polygon and non-negative homes and vehicles.")
    if not isinstance(area.get("exits"), list) or not area["exits"]:
        raise PackageError("no_exits", "No roads leave this area, so there is nowhere to evacuate to.")
    for x in area["exits"]:
        if not (isinstance(x, Mapping) and isinstance(x.get("node"), int) and 0 <= x["node"] < len(nodes)):
            raise bad("exit node index out of range.")
    if not isinstance(area.get("stations"), list):
        raise bad("stations must be a list.")
    return area


def _roads(area: Mapping[str, Any]) -> list[dict[str, Any]]:
    """v2 edge rows -> bundle directed edges. A two-way row becomes ``e{i}f`` and ``e{i}r``
    sharing ``segment_id`` ``s{i}``; node ids are ``n{index}``."""
    nodes = area["nodes"]
    classes = area["classes"]
    names = area.get("names") or []
    per_lane = dict((area.get("assumptions") or {}).get("capacityPerLaneVph") or {})
    default_lane = float(per_lane.get("other") or 600)
    out = []
    for i, edge in enumerate(area["edges"]):
        a, b, length, cls, kph, cap, oneway, name_i, geom = edge[:9]
        bridge = bool(edge[9]) if len(edge) > 9 else False
        highway = str(classes[cls])
        lane_cap = float(per_lane.get(highway.removesuffix("_link")) or default_lane)
        lanes = max(1, round(float(cap) / lane_cap)) if lane_cap > 0 else 1
        coords = [[float(nodes[a][0]), float(nodes[a][1])]]
        coords += [[float(geom[j]), float(geom[j + 1])] for j in range(0, len(geom), 2)]
        coords.append([float(nodes[b][0]), float(nodes[b][1])])
        name = names[name_i] if isinstance(name_i, int) and 0 <= name_i < len(names) else None
        base = {
            "segment_id": f"s{i}", "name": name, "highway": highway, "lanes": lanes,
            "speed_kph": float(kph), "capacity_veh_per_hour": float(cap), "length_m": float(length),
            "bridge": bridge,
        }
        out.append({"id": f"e{i}f", "from_node": f"n{a}", "to_node": f"n{b}", **base, "coords": coords})
        if not oneway:
            out.append({"id": f"e{i}r", "from_node": f"n{b}", "to_node": f"n{a}", **base, "coords": coords[::-1]})
    return out


def _zone_geometry(zone: Mapping[str, Any]) -> dict[str, Any]:
    """The zone's convex hull of synthetic homes, closed; a tiny or degenerate hull becomes a
    square of half-size ``MIN_ZONE_HALF_M`` around the zone centroid."""
    ring = [[float(p[0]), float(p[1])] for p in zone["polygon"]]
    if len({tuple(p) for p in ring}) >= 3:
        ring.append(ring[0])
        return {"type": "Polygon", "coordinates": [ring]}
    cx, cy = (float(v) for v in zone.get("centroid") or ring[0])
    dlat = MIN_ZONE_HALF_M / M_PER_DEG_LAT
    dlon = MIN_ZONE_HALF_M / (M_PER_DEG_LAT * math.cos(math.radians(cy)))
    square = [[cx - dlon, cy - dlat], [cx + dlon, cy - dlat], [cx + dlon, cy + dlat], [cx - dlon, cy + dlat]]
    return {"type": "Polygon", "coordinates": [[*square, square[0]]]}


def _arrival_grid(run: StudioRun) -> dict[str, Any]:
    """Resample the Mercator grid to the bundle's equirectangular ``arrival_grid`` (nearest cell,
    row 0 south) over the reached extent. ``minutes`` after ``t0``; null = not reached."""
    w, s, e, n = run.grid.reached_extent() or run.grid.extent()
    cell_m = max(run.grid.ground_cell_m, ARRIVAL_GRID_MIN_CELL_M)
    lat0 = (s + n) / 2
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat0))
    ncols = max(1, math.ceil((e - w) * m_lon / cell_m))
    nrows = max(1, math.ceil((n - s) * M_PER_DEG_LAT / cell_m))
    minutes: list[float | None] = []
    for row in range(nrows):
        lat = s + (row + 0.5) * cell_m / M_PER_DEG_LAT
        for col in range(ncols):
            lon = w + (col + 0.5) * cell_m / m_lon
            v = run.grid.at(lon, lat)
            minutes.append(None if v is None else round(v / 60, 1))
    return {
        "origin_lon": round(w, 6), "origin_lat": round(s, 6), "cell_m": round(cell_m, 2),
        "ncols": ncols, "nrows": nrows, "m_per_deg_lon": round(m_lon, 3), "m_per_deg_lat": M_PER_DEG_LAT,
        "t0": _iso(run.ignition_time), "minutes": minutes,
        "resampled_from": {"crs": "EPSG:3857", "ground_cell_m": run.grid.ground_cell_m, "method": "nearest"},
    }


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_run(run_raw: Mapping[str, Any]) -> bytes:
    return json.dumps(run_raw, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def package_hash(run_raw: Mapping[str, Any], area: Mapping[str, Any]) -> str:
    """Deterministic id material: the run export, the area id and builder, and this builder."""
    digest = hashlib.sha256()
    digest.update(BUILDER.encode())
    digest.update(_canonical_run(run_raw))
    digest.update(f"|{area.get('id')}|{area.get('builder')}|{area.get('generatedAt')}".encode())
    return digest.hexdigest()


def build_package(run_raw: Mapping[str, Any], area_raw: Any, box: AreaBox | None = None) -> dict[str, Any]:
    """Validate both inputs and return the drill package (a replay bundle, see module doc).

    ``box`` is the ``area_box`` the area was requested for (recomputed when None). Raises
    ``PackageError``.
    """
    run = parse_run(run_raw)
    box = box or area_box(run)
    area = _check_area(area_raw)
    digest = package_hash(run_raw, area)
    package_id = f"pkg_{digest[:12]}"
    incident_id = f"studio-{digest[:12]}"
    t0 = run.ignition_time
    clock_end = t0 + timedelta(minutes=run.horizon_min + CLOCK_TAIL_MIN)
    place = str(area.get("name") or "Selected area")
    label = f"Drill: simulated Studio fire, {run.name}. Not a real incident."

    edges = _roads(area)
    nodes = area["nodes"]

    zones = []
    for z in area["zones"]:
        zones.append({
            "id": str(z["id"]), "name": str(z.get("name") or z["id"]),
            "households": int(z["homes"]), "vehicles": int(z["vehicles"]),
            "evidence_class": "fixture", "synthetic": True,
            "geometry": _zone_geometry(z),
        })

    destinations = []
    for x in area["exits"]:
        lon, lat = nodes[x["node"]]
        destinations.append({
            "id": str(x["id"]), "name": str(x.get("name") or x["id"]), "kind": "exit",
            "coord": [float(lon), float(lat)], "capacity_veh": None, "node_id": f"n{x['node']}",
            "evidence_class": "derived",
        })

    stations = []
    for st in area["stations"]:
        stations.append({
            "id": str(st["id"]), "name": str(st.get("name") or "Fire station"),
            "coord": [float(st["location"][0]), float(st["location"][1])], "node_id": f"n{int(st['node'])}",
            "approach_m": st.get("approachMeters"),
            "units": [{"id": str(u["id"]), "type": str(u.get("type") or "engine"), "evidence_class": "fixture"}
                      for u in st.get("units") or []],
            "evidence_class": "observed",
        })

    fronts = []
    for frame in run.frames:
        if frame.geometry is None:
            continue
        fronts.append({
            "at": _iso(t0 + timedelta(minutes=frame.minute)), "minute": frame.minute,
            "area_km2": None if frame.area_m2 is None else round(frame.area_m2 / 1e6, 4),
            "evidence_class": "simulated", "geometry": to_geojson(frame.geometry),
        })

    ignitions = [
        {"id": ig.id, "name": ig.name, "coord": list(ig.coord), "start_minute": ig.start_minute,
         "at": _iso(t0 + timedelta(minutes=ig.start_minute)), "provenance": "assumed: placed in Simulation Studio"}
        for ig in run.ignitions
    ]
    area_assumptions = area.get("assumptions") or {}
    moisture_txt = ", ".join(f"{k} {v:.2f}" for k, v in run.moisture.items())
    assumptions = [
        f"Assumed wind: {run.wind_20ft_mph:g} mph open 20-ft wind from {run.wind_from_deg:g} deg true "
        "(the direction it blows from), constant for the whole run; not a forecast.",
        f"Assumed fuel moisture (fractions): {moisture_txt}; midflame adjustment {run.midflame_adjustment:g}.",
        f"Ignition time (drill T+0) {_iso(t0)} is chosen, not observed; ignitions are placed by hand.",
        *[str(note) for note in area_assumptions.get("notes") or []],
        f"Synthetic demand: {area_assumptions.get('homesPerKmApplied', '?')} homes per km of residential street, "
        f"{area_assumptions.get('vehiclesPerHome', '?')} vehicles per home.",
        "Road capacity and default speeds are assumed per road class; geometry is OpenStreetMap.",
    ]
    limitations = [
        f"Simulated fire ({run.model.get('id')} {run.model.get('version') or ''}".rstrip()
        + ", browser solver on LANDFIRE fuels and terrain), not an observed or forecast fire.",
        "No historical record: no perimeters, fire observations or events.",
        f"Fire spread stops at the {run.horizon_min} min horizon; the last front holds until clock.end.",
        "Zones are grid cells over synthetic homes, not official evacuation zones; households are homes.",
    ]
    if box.clipped:
        limitations.append("The fire is larger than the road area; roads and zones cover its centre only.")
    if run.landscape.get("elevation_complete") is False:
        limitations.append("Some terrain tiles were missing, so slope is understated in places.")
    missing = {"status": "missing", "evidence_class": None}

    return {
        "kind": "crisistwin_replay_bundle",
        "schema_version": "1.0.0",
        "drill_package": {
            "kind": PACKAGE_KIND, "version": PACKAGE_VERSION, "builder": BUILDER,
            "package_id": package_id, "source": "studio_scenario", "label": label,
            "studio": {
                "scenario_id": run.scenario_id, "name": run.name, "region_id": run.region_id,
                "model": dict(run.model), "landscape": dict(run.landscape),
            },
            "dispatch_area": {
                "id": area.get("id"), "builder": area.get("builder"), "bbox": area.get("bbox"),
                "requested_bbox": list(box.bbox), "clipped": box.clipped,
                "generated_at": area.get("generatedAt"), "sources": area.get("sources"),
            },
            "california_check": "box centre and every ignition inside livecore.package.CA_POLYGON",
        },
        "generated_by": {"builder": BUILDER, "command": "POST /api/live/packages"},
        "incident": {
            "id": incident_id, "name": f"{run.name} (Studio scenario)", "place": place,
            "package_version": digest[:16], "timezone": TIMEZONE, "registry_id": None,
        },
        "mode": "scenario",
        "clock": {"start": _iso(t0), "end": _iso(clock_end), "step_seconds": 60},
        "bbox": list(area.get("bbox") or box.bbox),
        "layer_status": {
            "roads": {"status": "present", "evidence_class": "derived", "reason": "OpenStreetMap, assumed capacity"},
            "zones": {"status": "fixture", "evidence_class": "fixture", "reason": "synthetic homes"},
            "destinations": {"status": "present", "evidence_class": "derived", "reason": "road exits from the box"},
            "stations": {"status": "present", "evidence_class": "observed", "reason": "OSM fire stations"},
            "fire_perimeters": {**missing, "reason": "simulated scenario: no observed perimeters"},
            "fire_simulated": {"status": "present", "evidence_class": "simulated", "reason": None},
            "fire_observations": {**missing, "reason": "simulated scenario: no observations"},
            "events": {**missing, "reason": "simulated scenario: no historical record"},
            "traffic": {**missing, "reason": "computed live by the traffic twin"},
            "damage": {**missing, "reason": "simulated scenario"},
        },
        "assumptions": assumptions,
        "limitations": limitations,
        "fire": {"perimeters": []},
        "fire_simulated": {
            "evidence_class": "simulated",
            "model": {
                "id": str(run.model.get("id")), "version": run.model.get("version"),
                "params": {
                    "wind_20ft_mph": run.wind_20ft_mph, "wind_from_deg": run.wind_from_deg,
                    "moisture_fractions": dict(run.moisture), "midflame_adjustment": run.midflame_adjustment,
                    "horizon_min": run.horizon_min, "spotting": run.spotting, "structure_spread": run.structure_spread,
                },
            },
            "ignitions": ignitions,
            "ignition": ignitions[0],
            "fronts": fronts,
            "arrival_grid": _arrival_grid(run),
            "assumptions": assumptions[:3],
        },
        "fire_observations": {"evidence_class": None, "features": []},
        "roads": {"evidence_class": "derived", "edges": edges},
        "zones": {"evidence_class": "fixture", "features": zones},
        "destinations": {"evidence_class": "derived", "features": destinations},
        "stations": {"evidence_class": "observed", "features": stations},
        "events": [],
    }


def package_summary(package: Mapping[str, Any]) -> dict[str, Any]:
    """Counts and labels for the API response and the package list."""
    meta = package["drill_package"]
    zones = package["zones"]["features"]
    fronts = package["fire_simulated"]["fronts"]
    last = fronts[-1] if fronts else None
    return {
        "name": package["incident"]["name"],
        "place": package["incident"]["place"],
        "label": meta["label"],
        "clock": {"start": package["clock"]["start"], "end": package["clock"]["end"]},
        "bbox": package["bbox"],
        "zones": len(zones),
        "homes": sum(z["households"] for z in zones),
        "vehicles": sum(z["vehicles"] for z in zones),
        "homes_label": "synthetic",
        "road_segments": len({e["segment_id"] for e in package["roads"]["edges"]}),
        "exits": len(package["destinations"]["features"]),
        "stations": len(package["stations"]["features"]),
        "fronts": len(fronts),
        "fire_area_km2": last["area_km2"] if last else None,
        "fire_label": "simulated",
        "clipped": meta["dispatch_area"]["clipped"],
        # The Studio region (prebuilt board id, e.g. "berkeley-hills-tilden") the run used, or None.
        "region_id": (meta.get("studio") or {}).get("region_id"),
    }


def load_package(path: str | Path) -> Drill:
    """``load_drill`` for a drill package, with its own incident id, label and name (``load_drill``
    alone would give a package the Camp label)."""
    with open(path, encoding="utf-8") as fh:
        head = json.load(fh)
    meta = head.get("drill_package") if isinstance(head, Mapping) else None
    if not isinstance(meta, Mapping) or meta.get("kind") != PACKAGE_KIND:
        raise ValueError("not a drill package")
    incident = head["incident"]
    drill = load_drill(path, incident_id=str(incident["id"]))
    return replace(drill, label=str(meta["label"]), name=str(incident["name"]))
