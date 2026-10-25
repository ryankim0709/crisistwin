"""Per-edge drive time of one fire-apparatus class: level speed, grade, curves and junctions
(docs/command-demo-realism.md "Travel time").

An edge's time is a one-dimensional speed profile along its geometry, sampled every
``step_m`` metres (``road_access.travel.profile_step_m``):

1. **Level speed cap** ``v_free`` (km/h): the road-access rules' speed on the level
   (``tools.suppression_data.road_access`` at grade 0: the posted/OSM speed capped by the class's
   road-class cap, unpaved and single-lane factors), capped again by the NFPA 1901 maximum top
   speed for the class's GVWR.
2. **Curves**: horizontal radius from the edge geometry (three-point circumradius of the
   vertices, neighbours at least ``curve_min_half_chord_m`` apart), each radius applied over the
   half-segments either side of its vertex; the AASHTO point-mass curve speed
   ``v = sqrt(127 R (e + f))`` with ``f`` from the AASHTO side-friction table at that speed.
3. **Grade**: a point-mass truck model (Rakha, Lucic, Demarchi, Setti & Van Aerde 2001,
   J. Transp. Eng. 127(5)): tractive force ``3600 eta P / v`` against aerodynamic, rolling and
   grade resistance, integrated along the signed DEM profile (momentum carries a truck over a
   short pitch; a long climb pulls it down to its crawl speed). Acceleration is capped at the
   NFPA 1901 minimum (0-35 mph in 25 s); braking for curves at the AASHTO 3.4 m/s^2.
   Downhill, speed is capped at the class's climbing speed on the same grade (the CDL rule:
   descend in the gear you would climb in).
4. **Junctions**: a complete stop at the end of an edge that meets a road of a higher OSM class
   (NFPA 1500: stop at stop signs and negative right-of-way intersections), a slow-down to a
   caution speed where it meets a road of its own class, nothing where it has priority. The
   speed-change time loss uses the same acceleration and braking rates.

Time attribution (``EdgeTravel``): ``free_s`` = length / v_free; ``curve_s`` = the extra time of the
profile with curves (and the braking and acceleration around them) on level ground; ``grade_s`` =
the extra time when the DEM grade is added; ``junction_s`` = the junction delay. Without an
elevation model ``grade_s`` is 0 and the basis says so.

Pure: no I/O. Parameters come from ``tools/suppression_resources.json``
(``road_access.travel`` and ``road_access.vehicle_classes``), each with its source or flagged
ASSUMPTION. Units are in the names: km/h, m/s, m/s^2, metres, seconds, kW, kg, N; grade is a
fraction (rise/run) unless named ``_pct``. Coordinates WGS84 ``(lon, lat)``.
"""

from __future__ import annotations

import bisect
import math
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache

from .geo import LonLat

G_MS2 = 9.8066
"""Gravitational acceleration as written in Rakha et al. (2001) eqs. 2-4."""
KMH_PER_MS = 3.6
KM_PER_MILE = 1.609344
KG_PER_LB = 0.45359237
KW_PER_HP = 0.745699872
"""Mechanical horsepower (550 ft-lbf/s), the unit of US engine ratings."""
V_MIN_KMH = 1.0
"""Floor of the speed in the tractive-force formula (``3600 eta P / v`` is singular at 0); the
NFPA acceleration cap governs at low speed anyway."""

Elevation = Callable[[float, float], "float | None"]

OSM_HIGHWAY_RANK = {
    "motorway": 8, "trunk": 7, "primary": 6, "secondary": 5, "tertiary": 4,
    "unclassified": 3, "residential": 2, "service": 1, "track": 0,
}
"""OSM road hierarchy (OpenStreetMap Wiki, Key:highway, "Roads" table: motorway > trunk >
primary > secondary > tertiary > unclassified > residential; service and track below). Used to
decide which approach of a junction yields. ``*_link`` and ``living_street`` are normalised first."""


# ---- vehicle -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Performance:
    """One class's point-mass parameters (``performance`` builds it from the data)."""

    vehicle: str
    mass_kg: float
    """GVWR (loaded, full tank)."""
    power_kw: float
    """Rated engine power."""
    drivetrain_efficiency: float
    drag_area_m2: float
    """Drag coefficient x frontal area."""
    rolling_cr: float
    rolling_c2: float
    rolling_c3: float
    aero_c1: float
    altitude_factor_per_m: float
    top_speed_kmh: float
    """NFPA 1901 maximum top speed for the class's GVWR."""
    accel_cap_ms2: float
    """NFPA 1901 minimum acceleration (0-35 mph in 25 s) used as the acceleration rate."""
    brake_decel_ms2: float
    """AASHTO stopping-sight-distance deceleration."""


def _v(data: Mapping, path: str):
    node = data
    for key in path.split("."):
        node = node[key]
    return node["value"]


def performance(data: Mapping, vehicle: str) -> Performance:
    """``Performance`` of ``vehicle`` from the suppression resources ``data``."""
    ra = data["road_access"]
    vc = ra["vehicle_classes"][vehicle]
    gvwr_lb = float(vc["gvwr_lb"]["value"])
    tr = "road_access.travel."
    top = _v(data, tr + "nfpa1901_max_top_speed_mph")
    # NFPA 1901 4.15.3 / 4.15.4: the lower limit applies above 50,000 lb GVWR (every class is above 26,000 lb).
    top_mph = float(top["gvwr_over_50000_lb"] if gvwr_lb > 50000 else top["gvwr_over_26000_lb"])
    accel = _v(data, tr + "nfpa1901_acceleration")
    rr = _v(data, tr + "rolling_resistance")
    return Performance(
        vehicle=vehicle,
        mass_kg=gvwr_lb * KG_PER_LB,
        power_kw=float(vc["engine_hp"]["value"]) * KW_PER_HP,
        drivetrain_efficiency=float(_v(data, tr + "drivetrain_efficiency")),
        drag_area_m2=float(_v(data, tr + "drag_coefficient")) * float(vc["frontal_area_m2"]["value"]),
        rolling_cr=float(rr["c_r"]),
        rolling_c2=float(rr["c2"]),
        rolling_c3=float(rr["c3"]),
        aero_c1=float(_v(data, tr + "aero_c1")),
        altitude_factor_per_m=float(_v(data, tr + "altitude_factor_per_m")),
        top_speed_kmh=top_mph * KM_PER_MILE,
        accel_cap_ms2=float(accel["to_mph"]) * KM_PER_MILE / KMH_PER_MS / float(accel["within_s"]),
        brake_decel_ms2=float(_v(data, tr + "braking_decel_ms2")),
    )


def tractive_force_n(p: Performance, v_kmh: float) -> float:
    """Rakha et al. (2001) eq. 1: F = 3600 eta P / v (P kW, v km/h, F N), power-limited."""
    return 3600.0 * p.drivetrain_efficiency * p.power_kw / max(v_kmh, V_MIN_KMH)


def resistance_n(p: Performance, v_kmh: float, grade: float, altitude_m: float) -> float:
    """Rakha et al. (2001) eqs. 2-4: aerodynamic ``c1 Cd Ch A v^2`` (Ch = 1 - 8.5e-5 H),
    rolling ``9.8066 Cr (c2 v + c3) m / 1000`` and grade ``9.8066 m i`` resistance, N
    (v km/h, m kg, i rise/run)."""
    ch = 1.0 - p.altitude_factor_per_m * max(0.0, altitude_m)
    aero = p.aero_c1 * p.drag_area_m2 * ch * v_kmh * v_kmh
    rolling = G_MS2 * p.rolling_cr * (p.rolling_c2 * v_kmh + p.rolling_c3) * p.mass_kg / 1000.0
    return aero + rolling + G_MS2 * p.mass_kg * grade


def accel_ms2(p: Performance, v_kmh: float, grade: float, altitude_m: float) -> float:
    """Maximum acceleration (negative: the truck slows on a climb at full power), m/s^2,
    capped above at the NFPA 1901 rate."""
    a = (tractive_force_n(p, v_kmh) - resistance_n(p, v_kmh, grade, altitude_m)) / p.mass_kg
    return min(p.accel_cap_ms2, a)


def steady_speed_kmh(p: Performance, grade: float, altitude_m: float = 0.0) -> float:
    """Speed at which full power just balances the resistances on a constant ``grade`` (the
    crawl speed on a climb), km/h; ``inf`` above 250 km/h (never the binding cap)."""
    if tractive_force_n(p, 250.0) >= resistance_n(p, 250.0, grade, altitude_m):
        return math.inf
    lo, hi = V_MIN_KMH, 250.0
    if tractive_force_n(p, lo) <= resistance_n(p, lo, grade, altitude_m):
        return lo
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if tractive_force_n(p, mid) > resistance_n(p, mid, grade, altitude_m):
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ---- curves ------------------------------------------------------------------------------


@dataclass(frozen=True)
class CurveParams:
    friction_speeds_kmh: tuple[float, ...]
    friction_f: tuple[float, ...]
    """AASHTO side-friction factor f at each design speed (ascending speeds)."""
    superelevation_by_rank: Mapping[str, float]
    """``highway`` or ``local`` -> e (fraction)."""
    min_half_chord_m: float

    def friction(self, v_kmh: float) -> float:
        """f at ``v_kmh``: linear between table speeds, the end values outside."""
        xs, ys = self.friction_speeds_kmh, self.friction_f
        if v_kmh <= xs[0]:
            return ys[0]
        if v_kmh >= xs[-1]:
            return ys[-1]
        i = bisect.bisect_right(xs, v_kmh)
        t = (v_kmh - xs[i - 1]) / (xs[i] - xs[i - 1])
        return ys[i - 1] + t * (ys[i] - ys[i - 1])

    def superelevation(self, highway: str) -> float:
        local = OSM_HIGHWAY_RANK.get(highway, 0) <= OSM_HIGHWAY_RANK["unclassified"]
        return float(self.superelevation_by_rank["local" if local else "highway"])


def curve_params(data: Mapping) -> CurveParams:
    tr = "road_access.travel."
    table = _v(data, tr + "side_friction_by_design_speed_kmh")
    pairs = sorted((float(k), float(f)) for k, f in table.items())
    return CurveParams(
        tuple(s for s, _ in pairs), tuple(f for _, f in pairs),
        dict(_v(data, tr + "superelevation")), float(_v(data, tr + "curve_min_half_chord_m")),
    )


def curve_speed_kmh(c: CurveParams, radius_m: float, e: float) -> float:
    """AASHTO simplified curve formula ``V^2 = 127 R (e + f)`` (V km/h, R m), solved with ``f``
    taken at V itself (f falls with speed). ``inf`` for a straight (R = inf)."""
    if not math.isfinite(radius_m):
        return math.inf
    lo, hi = 0.0, 300.0
    if hi * hi <= 127.0 * radius_m * (e + c.friction(hi)):
        return math.inf
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if mid * mid <= 127.0 * radius_m * (e + c.friction(mid)):
            lo = mid
        else:
            hi = mid
    return lo


# ---- geometry ----------------------------------------------------------------------------


@dataclass(frozen=True)
class EdgeGeometry:
    """Class-independent samples of one directed edge, every ``step`` metres or less."""

    step_m: tuple[float, ...]
    """Length of each piece between consecutive samples (n - 1 values)."""
    radius_m: tuple[float, ...]
    """Horizontal radius at each sample (inf on a straight)."""
    height_m: tuple[float, ...] | None
    """Median-filtered DEM height at each sample; None without an elevation model."""
    sustained_grade: tuple[float, ...] | None
    """Signed grade (rise/run, travel direction) over the grade window centred on each sample."""
    length_m: float


def _xy(coords: Sequence[LonLat]) -> list[tuple[float, float]]:
    """Equirectangular metres about the first point (fine over one edge)."""
    lon0, lat0 = coords[0]
    kx = math.cos(math.radians(lat0)) * math.pi * 6_371_008.8 / 180.0
    ky = math.pi * 6_371_008.8 / 180.0
    return [((lon - lon0) * kx, (lat - lat0) * ky) for lon, lat in coords]


def _circumradius(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    ab = math.dist(a, b)
    bc = math.dist(b, c)
    ca = math.dist(c, a)
    cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    if cross < 1e-9:
        return math.inf
    return ab * bc * ca / (2.0 * cross)


def vertex_radii(xy: Sequence[tuple[float, float]], min_half_chord_m: float) -> list[tuple[float, float, float]]:
    """(along_start_m, along_end_m, radius_m) per interior vertex: the circumradius of the vertex
    and the nearest vertices at least ``min_half_chord_m`` before and after it along the line,
    applied from half-way to the previous vertex to half-way to the next. A uniformly digitized
    arc gives its true radius; a coarse corner gives the largest arc through its neighbours."""
    n = len(xy)
    along = [0.0]
    for i in range(1, n):
        along.append(along[-1] + math.dist(xy[i - 1], xy[i]))
    out: list[tuple[float, float, float]] = []
    for i in range(1, n - 1):
        j = i - 1
        while j > 0 and along[i] - along[j] < min_half_chord_m:
            j -= 1
        k = i + 1
        while k < n - 1 and along[k] - along[i] < min_half_chord_m:
            k += 1
        r = _circumradius(xy[j], xy[i], xy[k])
        if math.isfinite(r):
            out.append((0.5 * (along[i - 1] + along[i]), 0.5 * (along[i] + along[i + 1]), r))
    return out


def edge_geometry(coords: Sequence[LonLat], step_m: float, min_half_chord_m: float,
                  elevation: Elevation | None, median_half_m: float, grade_window_m: float) -> EdgeGeometry:
    """Sample ``coords`` (travel order) every ``step_m`` or less; radius per sample; with
    ``elevation`` the height profile median-filtered over +/- ``median_half_m`` and the grade
    over ``grade_window_m`` centred on each sample (shorter at the ends)."""
    xy = _xy(coords)
    seg = [math.dist(xy[i - 1], xy[i]) for i in range(1, len(xy))]
    length = sum(seg)
    pieces = max(1, math.ceil(length / step_m))
    step = length / pieces if length > 0 else 0.0
    along_s = [i * step for i in range(pieces + 1)]
    radius = [math.inf] * (pieces + 1)
    for a0, a1, r in vertex_radii(xy, min_half_chord_m):
        lo = max(0, math.floor(a0 / step) if step > 0 else 0)
        hi = min(pieces, math.ceil(a1 / step) if step > 0 else 0)
        for i in range(lo, hi + 1):
            if a0 <= along_s[i] <= a1 and r < radius[i]:
                radius[i] = r
    heights = None
    grades = None
    if elevation is not None and length > 0:
        pts: list[LonLat] = []
        cum = 0.0
        si = 0
        for i in range(pieces + 1):
            target = along_s[i]
            while si < len(seg) - 1 and cum + seg[si] < target:
                cum += seg[si]
                si += 1
            t = 0.0 if seg[si] <= 0 else min(1.0, max(0.0, (target - cum) / seg[si]))
            a, b = coords[si], coords[si + 1]
            pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        raw = [elevation(lon, lat) for lon, lat in pts]
        if all(z is not None for z in raw):
            half = max(0, round(median_half_m / step)) if step > 0 else 0
            vals = [float(z) for z in raw]  # type: ignore[arg-type]
            heights = [statistics.median(vals[max(0, i - half):i + half + 1]) for i in range(len(vals))]
            w = max(1, round(0.5 * grade_window_m / step))
            grades = []
            for i in range(len(heights)):
                i0, i1 = max(0, i - w), min(len(heights) - 1, i + w)
                run = along_s[i1] - along_s[i0]
                grades.append((heights[i1] - heights[i0]) / run if run > 0 else 0.0)
    return EdgeGeometry(tuple([step] * pieces), tuple(radius),
                        tuple(heights) if heights is not None else None,
                        tuple(grades) if grades is not None else None, length)


def reversed_geometry(g: EdgeGeometry) -> EdgeGeometry:
    """The same road driven the other way (heights reversed, grades negated)."""
    return EdgeGeometry(
        tuple(reversed(g.step_m)), tuple(reversed(g.radius_m)),
        tuple(reversed(g.height_m)) if g.height_m is not None else None,
        tuple(-x for x in reversed(g.sustained_grade)) if g.sustained_grade is not None else None,
        g.length_m,
    )


# ---- one edge ----------------------------------------------------------------------------


@dataclass(frozen=True)
class EdgeTravel:
    seconds: float
    """Total drive seconds: ``free_s + curve_s + grade_s + junction_s``."""
    free_s: float
    curve_s: float
    grade_s: float
    junction_s: float
    curved_m: float
    """Metres where the curve speed is below the level cap."""
    junction: str
    """``stop``, ``caution`` or ``none`` at the edge's end node."""


@lru_cache(maxsize=4096)
def _steady_cached(p: Performance, grade_milli: int, altitude_100m: int) -> float:
    return steady_speed_kmh(p, grade_milli / 1000.0, altitude_100m * 100.0)


def _profile_seconds(p: Performance, steps: Sequence[float], cap_kmh: Sequence[float],
                     grade: Sequence[float] | None, altitude_m: float) -> float:
    """Seconds along one edge: forward pass with the truck's acceleration (power-limited, NFPA
    capped; negative on a climb it cannot hold speed on) under ``cap_kmh``, then a backward pass
    braking at ``brake_decel_ms2`` for the caps ahead. Entry speed: the cap at the first sample,
    or the crawl speed on the first sample's grade if lower."""
    n = len(cap_kmh)
    v = [0.0] * n  # m/s
    g0 = grade[0] if grade is not None else 0.0
    v[0] = min(cap_kmh[0], _steady_cached(p, round(g0 * 1000), round(altitude_m / 100))) / KMH_PER_MS
    for i in range(1, n):
        g = grade[i - 1] if grade is not None else 0.0
        a = accel_ms2(p, v[i - 1] * KMH_PER_MS, g, altitude_m)
        v2 = v[i - 1] * v[i - 1] + 2.0 * a * steps[i - 1]
        vi = math.sqrt(v2) if v2 > 0 else V_MIN_KMH / KMH_PER_MS
        v[i] = min(cap_kmh[i] / KMH_PER_MS, max(vi, V_MIN_KMH / KMH_PER_MS))
    d = p.brake_decel_ms2
    for i in range(n - 2, -1, -1):
        lim = math.sqrt(v[i + 1] * v[i + 1] + 2.0 * d * steps[i])
        if v[i] > lim:
            v[i] = lim
    return sum(2.0 * steps[i] / (v[i] + v[i + 1]) for i in range(n - 1))


def edge_travel(p: Performance, c: CurveParams, geom: EdgeGeometry, free_kmh: float, highway: str,
                junction: str, junction_caution_kmh: float, junction_stop_dwell_s: float) -> EdgeTravel:
    """Drive time of one edge (``EdgeTravel``) for performance ``p`` at level cap ``free_kmh``."""
    v_free = min(free_kmh, p.top_speed_kmh)
    length = geom.length_m
    if length <= 0 or v_free <= 0:
        return EdgeTravel(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "none")
    free_s = length / (v_free / KMH_PER_MS)
    e = c.superelevation(highway)
    curve_cap = [min(v_free, curve_speed_kmh(c, r, e)) for r in geom.radius_m]
    curved_m = sum(s for s, cap in zip(geom.step_m, curve_cap, strict=False) if cap < v_free - 1e-6)
    altitude = statistics.fmean(geom.height_m) if geom.height_m else 0.0
    # Level ground with curves: curve_s includes the braking into and acceleration out of them.
    level_s = _profile_seconds(p, geom.step_m, curve_cap, None, altitude)
    grade_s = 0.0
    if geom.height_m is not None and geom.sustained_grade is not None and len(geom.height_m) == len(curve_cap):
        steps = geom.step_m
        piece_grade = [(geom.height_m[i + 1] - geom.height_m[i]) / steps[i] if steps[i] > 0 else 0.0
                       for i in range(len(steps))]
        # Downhill: no faster than the class climbs the same sustained grade (CDL gear rule).
        caps = [cap if g >= 0 else min(cap, _steady_cached(p, round(-g * 1000), round(altitude / 100)))
                for cap, g in zip(curve_cap, geom.sustained_grade, strict=True)]
        graded_s = _profile_seconds(p, steps, caps, piece_grade, altitude)
        grade_s = graded_s - level_s
    curve_s = level_s - free_s
    v_end = curve_cap[-1] / KMH_PER_MS
    junction_s = 0.0
    if junction in ("stop", "caution"):
        v_low = 0.0 if junction == "stop" else min(v_end, junction_caution_kmh / KMH_PER_MS)
        if v_end > v_low:
            # Time lost slowing from v to v_low at d and regaining v at a: (v - v_low)^2 / (2 v) (1/a + 1/d).
            junction_s = (v_end - v_low) ** 2 / (2.0 * v_end) * (1.0 / p.accel_cap_ms2 + 1.0 / p.brake_decel_ms2)
        if junction == "stop":
            junction_s += junction_stop_dwell_s
    total = free_s + curve_s + grade_s + junction_s
    return EdgeTravel(total, free_s, curve_s, grade_s, junction_s, curved_m, junction)


# ---- junctions on a graph ----------------------------------------------------------------


def junction_kind(own_highway: str, own_name: str | None, own_segment: str, end_heading_deg: float,
                  others: Sequence[tuple[str, str, str | None, float]]) -> str:
    """``stop``, ``caution`` or ``none`` for an edge arriving at a node.

    ``others``: (segment id, highway, name, heading leaving the node, degrees) of every other road
    segment at the node. The continuation of the arriving road (same name, else same class,
    closest to straight ahead) is removed; the rest are cross roads. No cross road: not a
    junction. A cross road of a higher OSM class: ``stop`` (the arriving road yields). One of
    the same class: ``caution``. Only lower classes: ``none`` (the arriving road has priority)."""
    rank = OSM_HIGHWAY_RANK.get(own_highway, 0)
    cands = [o for o in others if o[0] != own_segment]
    if not cands:
        return "none"

    def turn(h: float) -> float:
        return abs((h - end_heading_deg + 180.0) % 360.0 - 180.0)

    same_name = [o for o in cands if own_name and o[2] == own_name]
    pool = same_name or [o for o in cands if o[1] == own_highway]
    if pool:
        cont = min(pool, key=lambda o: turn(o[3]))
        cands = [o for o in cands if o is not cont]
    if not cands:
        return "none"
    top = max(OSM_HIGHWAY_RANK.get(o[1], 0) for o in cands)
    if top > rank:
        return "stop"
    if top == rank:
        return "caution"
    return "none"


def heading_deg(a: LonLat, b: LonLat) -> float:
    """Initial compass heading from ``a`` to ``b`` (equirectangular), degrees."""
    dx = (b[0] - a[0]) * math.cos(math.radians(0.5 * (a[1] + b[1])))
    dy = b[1] - a[1]
    return math.degrees(math.atan2(dx, dy)) % 360.0


def rand_travel_min(distance_km: float, intercept_min: float, min_per_mile: float) -> float:
    """Kolesar (1975) / RAND fire-engine travel time ``T = a + b D`` (T minutes, D miles), as a
    cross-check of average speeds; ``distance_km`` is converted to miles."""
    return intercept_min + min_per_mile * distance_km / KM_PER_MILE
