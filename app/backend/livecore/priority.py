"""Information priority: which places most need a fresh observation (ADR 0041).

``priority = impact × p_change × staleness``, each in 0..1, for three kinds of place:

- ``segment``: road segments on published routes (vehicles that would lose or lengthen a route);
- ``destination``: destinations near capacity (arrivals vs capacity);
- ``gateway``: zones the fire model reaches within GATEWAY_HORIZON_MIN that the current estimate
  does not yet touch, weighted by modelled spread acceleration.

Every number comes from the models (planner routes, traffic twin or plan, fire model fronts) and
the report clock; an LLM never sets one. Pure: no Django, no PyMongo. Contract:
docs/live-reports.md "Task board, passive observations and information priority (ADR 0041)".
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from .drill import FireSnapshot, Zone
from .geo import LonLat, MultiPolygon, _cached, distance_km, haversine_m, point_in_multipolygon
from .public import HALF_LIFE_S

IMPACT_SCALE_VEH = 5000.0
"""impact = 1 - exp(-vehicle_equivalents / IMPACT_SCALE_VEH): 5000 vehicles at stake -> 0.63 (a Camp
zone has about 1700). ASSUMPTION."""
LOSE_ROUTE_WEIGHT = 2.0
"""A zone whose published alternatives all cross the segment counts this many times its vehicles
(closing the segment loses its route or forces a long detour); a zone with an alternative that
avoids it counts once (its route would lengthen). ASSUMPTION."""
ON_ROUTE_M = 30.0
"""A line uses a segment when two of the segment's quarter points lie this close (as the impact analysis)."""
MIN_SEGMENT_LENGTH_M = 150.0
"""Shorter segments are not candidates: too short to observe or to traverse passively."""
SEGMENT_REFINE_MAX = 150
"""Only the SEGMENT_REFINE_MAX segments with the most vehicles get the alternative test and fire
distance (cost bound); the rest keep base impact and p_change from the half-life alone."""
PRIORITY_HORIZON_S = 1800.0
"""p_base = chance the place changes within this horizon from its kind's half-life alone."""
FIRE_DECAY_M = 2000.0
"""p_fire = exp(-distance_to_fire / FIRE_DECAY_M). ASSUMPTION."""
FIRE_DISTANCE_MAX_M = 10_000.0
"""Beyond this the fire term is 0 (exp(-5) < 0.01)."""
FIRE_GRID_M = 1000.0
"""Cell size of the fire-boundary vertex grid used for place-to-fire distances."""
GATEWAY_HORIZON_MIN = 30
"""Fire-growth gateways: zones the model front reaches within this many drill minutes."""
GATEWAY_MAX_SPREAD_RATIO = 3.0
"""spread_ratio = clamp(modelled growth next horizon / growth last horizon, 1, this)."""
GATEWAY_OBSERVATION_M = 1000.0
"""fire_seen / heavy_smoke reports within this distance of a gateway refresh it."""
SEGMENT_HALF_LIFE_KIND = "road_blocked"
DESTINATION_HALF_LIFE_KIND = "shelter_full"
GATEWAY_HALF_LIFE_KIND = "fire_seen"

PlaceKind = Literal["segment", "destination", "gateway"]


@dataclass(frozen=True)
class RouteUse:
    """One zone's published route, as the priority model needs it."""

    zone_id: str
    vehicles: int
    segment_ids: frozenset[str]
    """Segments of the published route (planner edge ids of the same destination and via)."""
    alternative_lines: tuple[tuple[LonLat, ...], ...]
    """Lines of the zone's other published alternatives (not the recommended one)."""


@dataclass(frozen=True)
class SegmentInfo:
    line: tuple[LonLat, ...]
    name: str | None
    length_m: float


@dataclass(frozen=True)
class DestinationInfo:
    id: str
    name: str
    coord: LonLat
    capacity: float | None
    """Vehicles (``capacity_veh``) or, for an exit, vehicles per hour; None when unknown."""


@dataclass(frozen=True)
class PriorityItem:
    id: str
    """``seg:<segment_id>`` | ``dst:<destination_id>`` | ``gw:<zone_id>``."""
    kind: PlaceKind
    name: str
    coord: LonLat
    line: tuple[LonLat, ...] | None
    segment_id: str | None
    destination_id: str | None
    zone_id: str | None
    priority: float
    impact: float
    p_change: float
    staleness: float
    vehicles: float | None
    """Vehicle-equivalents at stake (segment: weighted zone vehicles; gateway: zone vehicles × spread)."""
    zones: int | None
    zones_losing_route: int | None
    load: float | None
    households: int | None
    spread_ratio: float | None
    fire_distance_m: float | None
    half_life_s: float
    last_observed_at: datetime | None
    reason: str


# ---- the three factors ----


def impact_from_vehicles(vehicles: float) -> float:
    """``1 - exp(-v / IMPACT_SCALE_VEH)``, 0..1; 0 for v <= 0."""
    return 0.0 if vehicles <= 0 else 1.0 - math.exp(-vehicles / IMPACT_SCALE_VEH)


def half_life(kind: str) -> float:
    return float(HALF_LIFE_S[kind])


def p_change(half_life_s: float, fire_distance_m: float | None) -> float:
    """``1 - (1 - p_base)(1 - p_fire)``: p_base = 1 - 0.5 ** (PRIORITY_HORIZON_S / half_life_s),
    p_fire = exp(-d / FIRE_DECAY_M) (0 without a fire estimate or beyond FIRE_DISTANCE_MAX_M)."""
    p_base = 1.0 - 0.5 ** (PRIORITY_HORIZON_S / half_life_s)
    if fire_distance_m is None or not math.isfinite(fire_distance_m) or fire_distance_m > FIRE_DISTANCE_MAX_M:
        p_fire = 0.0
    else:
        p_fire = math.exp(-max(0.0, fire_distance_m) / FIRE_DECAY_M)
    return 1.0 - (1.0 - p_base) * (1.0 - p_fire)


def staleness(half_life_s: float, last_observed_at: datetime | None, wall_now: datetime) -> float:
    """``1 - 0.5 ** (age_s / half_life_s)`` since the newest independent observation; 1 when never observed."""
    if last_observed_at is None:
        return 1.0
    age_s = max(0.0, (wall_now - last_observed_at).total_seconds())
    return 1.0 - 0.5 ** (age_s / half_life_s)


def _round(x: float, n: int = 3) -> float:
    return round(x, n)


# ---- geometry helpers ----

_M_PER_DEG_LAT = 111_320.0


def _point_line_m(p: LonLat, line: Sequence[LonLat]) -> float:
    k = math.cos(math.radians(p[1])) * _M_PER_DEG_LAT
    best = math.inf
    for a, b in zip(line, line[1:]):
        ax, ay = (a[0] - p[0]) * k, (a[1] - p[1]) * _M_PER_DEG_LAT
        bx, by = (b[0] - p[0]) * k, (b[1] - p[1]) * _M_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        t = 0.0 if len2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / len2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def along(line: Sequence[LonLat], fraction: float) -> LonLat:
    """The point at ``fraction`` (0..1) of the line's length."""
    lengths = [haversine_m(a, b) for a, b in zip(line, line[1:])]
    target = sum(lengths) * fraction
    for (a, b), length in zip(zip(line, line[1:]), lengths):
        if target <= length:
            t = 0.0 if length == 0 else target / length
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        target -= length
    return tuple(line[-1])  # type: ignore[return-value]


def _bbox(points: Sequence[LonLat]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def segment_on_line(segment_line: Sequence[LonLat], line: Sequence[LonLat], on_route_m: float = ON_ROUTE_M) -> bool:
    """Two of the segment's quarter points within ``on_route_m`` of ``line``."""
    if len(segment_line) < 2 or len(line) < 2:
        return False
    a, b = _bbox(segment_line), _bbox(line)
    pad = on_route_m / _M_PER_DEG_LAT * 2  # degrees, generous in longitude at these latitudes
    if a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1]:
        return False
    near = sum(1 for f in (0.25, 0.5, 0.75) if _point_line_m(along(segment_line, f), line) <= on_route_m)
    return near >= 2


class _FireVertices:
    """Fire boundary vertices projected (equirectangular, meters) into a FIRE_GRID_M grid."""

    def __init__(self, fire: MultiPolygon) -> None:
        self.lat0 = fire[0][0][0][1]
        self.kx = math.cos(math.radians(self.lat0)) * _M_PER_DEG_LAT
        self.cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for polygon in fire:
            for ring in polygon:
                for lon, lat in ring:
                    x, y = lon * self.kx, lat * _M_PER_DEG_LAT
                    self.cells.setdefault((int(x // FIRE_GRID_M), int(y // FIRE_GRID_M)), []).append((x, y))

    def nearest_m(self, p: LonLat) -> float:
        x, y = p[0] * self.kx, p[1] * _M_PER_DEG_LAT
        cx, cy = int(x // FIRE_GRID_M), int(y // FIRE_GRID_M)
        best = math.inf
        max_ring = int(FIRE_DISTANCE_MAX_M // FIRE_GRID_M) + 1
        for r in range(max_ring + 1):
            if best <= (r - 1) * FIRE_GRID_M:
                break
            for i in range(cx - r, cx + r + 1):
                for j in range(cy - r, cy + r + 1):
                    if max(abs(i - cx), abs(j - cy)) != r:
                        continue
                    for vx, vy in self.cells.get((i, j), ()):
                        d = math.hypot(vx - x, vy - y)
                        if d < best:
                            best = d
        return best


def fire_distance_m(line: Sequence[LonLat], fire: MultiPolygon | None) -> float | None:
    """Meters from a place (point or line) to the fire estimate; 0 when a sampled point is inside;
    None without an estimate; ``inf`` beyond FIRE_DISTANCE_MAX_M.

    Approximation for ranking: the line is sampled at its ends and quarter points, and the distance
    is to the nearest fire boundary vertex (an overestimate by at most half the vertex spacing).
    """
    if fire is None or not fire:
        return None
    points = [line[0]] if len(line) < 2 else [along(line, f) for f in (0.0, 0.25, 0.5, 0.75, 1.0)]
    if any(point_in_multipolygon(p, fire) for p in points):
        return 0.0
    grid = _cached(fire, "priority-vertices", FIRE_GRID_M, lambda: _FireVertices(fire))
    d = min(grid.nearest_m(p) for p in points)
    return d if d <= FIRE_DISTANCE_MAX_M else math.inf


def _ring_area_m2(ring: Sequence[LonLat]) -> float:
    if len(ring) < 3:
        return 0.0
    lat0 = ring[0][1]
    kx = math.cos(math.radians(lat0)) * _M_PER_DEG_LAT
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        a += (x1 * kx) * (y2 * _M_PER_DEG_LAT) - (x2 * kx) * (y1 * _M_PER_DEG_LAT)
    return abs(a) / 2.0


def area_m2(geometry: MultiPolygon) -> float:
    """Planar area (exterior rings minus holes), square meters."""
    total = 0.0
    for polygon in geometry:
        if not polygon:
            continue
        total += _ring_area_m2(polygon[0]) - sum(_ring_area_m2(h) for h in polygon[1:])
    return max(0.0, total)


# ---- candidates ----


def segment_items(
    routes: Sequence[RouteUse],
    segments: Mapping[str, SegmentInfo],
    last_observed: Mapping[str, datetime],
    fire: MultiPolygon | None,
    wall_now: datetime,
) -> list[PriorityItem]:
    """Road segments on published routes.

    Cheap approximation of the impact analysis from published route edges (no planner runs):
    vehicles = sum over zones whose published route crosses the segment of the zone's vehicles,
    times LOSE_ROUTE_WEIGHT when none of the zone's published alternatives avoids the segment
    (``segment_on_line``). Segments shorter than MIN_SEGMENT_LENGTH_M are skipped. Only the
    SEGMENT_REFINE_MAX segments with the most (unweighted) vehicles are scored.
    """
    users: dict[str, list[RouteUse]] = {}
    for r in routes:
        for seg in r.segment_ids:
            info = segments.get(seg)
            if info is not None and info.length_m >= MIN_SEGMENT_LENGTH_M:
                users.setdefault(seg, []).append(r)
    base = sorted(users, key=lambda s: (-sum(r.vehicles for r in users[s]), s))[:SEGMENT_REFINE_MAX]
    hl = half_life(SEGMENT_HALF_LIFE_KIND)
    out: list[PriorityItem] = []
    for seg in base:
        info = segments[seg]
        vehicles = 0.0
        losing = 0
        for r in users[seg]:
            avoids = any(not segment_on_line(info.line, alt) for alt in r.alternative_lines if len(alt) >= 2)
            if avoids:
                vehicles += r.vehicles
            else:
                losing += 1
                vehicles += LOSE_ROUTE_WEIGHT * r.vehicles
        d = fire_distance_m(info.line, fire)
        imp = impact_from_vehicles(vehicles)
        pc = p_change(hl, d)
        last = last_observed.get(seg)
        st = staleness(hl, last, wall_now)
        n = len(users[seg])
        raw = sum(r.vehicles for r in users[seg])
        reason = f"{raw} vehicles on {n} route{'s' if n != 1 else ''}"
        if losing:
            reason += f", {losing} without another way"
        out.append(PriorityItem(
            id=f"seg:{seg}", kind="segment", name=info.name or "Unnamed road", coord=along(info.line, 0.5),
            line=tuple(info.line), segment_id=seg, destination_id=None, zone_id=None,
            priority=_round(imp * pc * st, 4), impact=_round(imp), p_change=_round(pc), staleness=_round(st),
            vehicles=round(vehicles, 1), zones=n, zones_losing_route=losing, load=None, households=None,
            spread_ratio=None, fire_distance_m=_finite(d), half_life_s=hl, last_observed_at=last, reason=reason,
        ))
    return out


def destination_items(
    destinations: Sequence[DestinationInfo],
    arrivals: Mapping[str, float],
    last_observed: Mapping[str, datetime],
    fire: MultiPolygon | None,
    wall_now: datetime,
) -> list[PriorityItem]:
    """Destinations near capacity: vehicles = arrivals × load, load = min(1, arrivals / capacity).

    ``arrivals`` is in the same unit as ``capacity`` (vehicles, or vehicles per hour for an exit).
    Destinations with unknown capacity or no arrivals are skipped.
    """
    hl = half_life(DESTINATION_HALF_LIFE_KIND)
    out: list[PriorityItem] = []
    for dest in destinations:
        heading = float(arrivals.get(dest.id, 0.0))
        if not dest.capacity or dest.capacity <= 0 or heading <= 0:
            continue
        load = min(1.0, heading / dest.capacity)
        vehicles = heading * load
        d = fire_distance_m([dest.coord], fire)
        imp = impact_from_vehicles(vehicles)
        pc = p_change(hl, d)
        last = last_observed.get(dest.id)
        st = staleness(hl, last, wall_now)
        out.append(PriorityItem(
            id=f"dst:{dest.id}", kind="destination", name=dest.name, coord=dest.coord, line=None,
            segment_id=None, destination_id=dest.id, zone_id=None,
            priority=_round(imp * pc * st, 4), impact=_round(imp), p_change=_round(pc), staleness=_round(st),
            vehicles=round(vehicles, 1), zones=None, zones_losing_route=None, load=round(load, 2), households=None,
            spread_ratio=None, fire_distance_m=_finite(d), half_life_s=hl, last_observed_at=last,
            reason=f"Load {load:.2f} of capacity",
        ))
    return out


def _latest_at_or_before(fronts: Sequence[FireSnapshot], t: datetime) -> FireSnapshot | None:
    found = None
    for f in fronts:
        if f.at > t:
            break
        found = f
    return found


def spread_ratio(fronts: Sequence[FireSnapshot], replay_now: datetime,
                 horizon_min: int = GATEWAY_HORIZON_MIN) -> tuple[FireSnapshot | None, FireSnapshot | None, float]:
    """``(current front, front at the horizon, spread_ratio)`` from the simulated fronts (sorted by ``at``).

    spread_ratio = clamp(area growth over the next horizon / area growth over the last one, 1,
    GATEWAY_MAX_SPREAD_RATIO); 1 when the past growth is unknown or zero. The horizon front is
    None when the model has no front after ``replay_now``.
    """
    h = timedelta(minutes=horizon_min)
    current = _latest_at_or_before(fronts, replay_now)
    ahead = _latest_at_or_before(fronts, replay_now + h)
    if ahead is None or (current is not None and ahead.at <= current.at):
        return current, None, 1.0
    past = _latest_at_or_before(fronts, replay_now - h)
    a_now = area_m2(current.geometry) if current else 0.0
    growth_next = area_m2(ahead.geometry) - a_now
    growth_prev = a_now - (area_m2(past.geometry) if past else 0.0)
    if growth_prev <= 0:
        return current, ahead, 1.0
    return current, ahead, min(GATEWAY_MAX_SPREAD_RATIO, max(1.0, growth_next / growth_prev))


def gateway_items(
    zones: Sequence[Zone],
    fronts: Sequence[FireSnapshot],
    fire: MultiPolygon | None,
    replay_now: datetime,
    fire_points: Sequence[tuple[LonLat, datetime]],
    wall_now: datetime,
) -> list[PriorityItem]:
    """Zones with households that the model front reaches within GATEWAY_HORIZON_MIN but the current
    estimate (``fire``, else the current front) does not touch. Simulated fronts only, never future
    observed perimeters. The place is the zone's boundary vertex inside the horizon front that is
    nearest the current fire (measured to a sample of up to 64 vertices per fire ring). ``fire_points``
    are ``fire_seen``/``heavy_smoke`` (coord, effective time) for staleness.
    """
    current, ahead, ratio = spread_ratio(fronts, replay_now)
    if ahead is None:
        return []
    now_geom = fire if fire is not None else (current.geometry if current else None)
    sample = [p for poly in now_geom for p in poly[0][:: max(1, len(poly[0]) // 64)]] if now_geom else []
    hl = half_life(GATEWAY_HALF_LIFE_KIND)
    out: list[PriorityItem] = []
    ahead_box = _bbox([p for poly in ahead.geometry for p in poly[0]])
    for zone in zones:
        if zone.households <= 0:
            continue
        zb = _bbox([p for poly in zone.geometry for p in poly[0]])
        if zb[2] < ahead_box[0] or ahead_box[2] < zb[0] or zb[3] < ahead_box[1] or ahead_box[3] < zb[1]:
            continue
        if now_geom is not None and distance_km(zone.geometry, now_geom) == 0.0:
            continue
        if distance_km(zone.geometry, ahead.geometry) > 0.0:
            continue
        inside = [p for poly in zone.geometry for p in poly[0] if point_in_multipolygon(p, ahead.geometry)]
        if not inside:
            inside = [p for poly in zone.geometry for p in poly[0]]
        if sample:
            place = min(inside, key=lambda p: (min(haversine_m(p, q) for q in sample), p))
        else:
            place = inside[0]
        d = fire_distance_m([place], fire)
        vehicles = zone.vehicles * ratio
        imp = impact_from_vehicles(vehicles)
        pc = p_change(hl, d)
        seen = [t for c, t in fire_points if haversine_m(c, place) <= GATEWAY_OBSERVATION_M]
        last = max(seen) if seen else None
        st = staleness(hl, last, wall_now)
        reason = f"Model reaches {zone.households} households within {GATEWAY_HORIZON_MIN} min"
        if ratio > 1.0:
            reason += f", spread ×{ratio:.1f}"
        out.append(PriorityItem(
            id=f"gw:{zone.id}", kind="gateway", name=zone.name, coord=(round(place[0], 6), round(place[1], 6)),
            line=None, segment_id=None, destination_id=None, zone_id=zone.id,
            priority=_round(imp * pc * st, 4), impact=_round(imp), p_change=_round(pc), staleness=_round(st),
            vehicles=round(vehicles, 1), zones=None, zones_losing_route=None, load=None,
            households=zone.households, spread_ratio=round(ratio, 2), fire_distance_m=_finite(d),
            half_life_s=hl, last_observed_at=last, reason=reason,
        ))
    return out


def _finite(d: float | None) -> float | None:
    return None if d is None or not math.isfinite(d) else round(d)


def rank(items: Sequence[PriorityItem]) -> list[PriorityItem]:
    """Priority descending, then id (deterministic)."""
    return sorted(items, key=lambda i: (-i.priority, i.id))


def select_diverse(items: Sequence[PriorityItem], spacing_m: float, limit: int,
                   taken: Sequence[LonLat] = ()) -> list[PriorityItem]:
    """The best ``limit`` items (in the given order) at least ``spacing_m`` from each other and from
    ``taken``, so one long road does not fill the list with its consecutive segments."""
    chosen: list[PriorityItem] = []
    points = list(taken)
    for item in items:
        if len(chosen) >= limit:
            break
        if any(haversine_m(item.coord, p) < spacing_m for p in points):
            continue
        chosen.append(item)
        points.append(item.coord)
    return chosen
