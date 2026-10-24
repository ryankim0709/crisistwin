"""Wind-driven elliptical fire spread on uniform fuel, solved as minimum travel time.

Each cell's arrival time is the shortest travel time from the ignition cells over a
16-neighbour stencil (Dijkstra). The spread rate along a stencil direction comes from
a fire ellipse with the ignition point at its rear focus. There is no terrain, fuel
variation, spotting, suppression, or time-varying weather; fuel is uniform everywhere.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import asdict, dataclass

from sim.geo import Grid

MODEL_ID = "elliptical-mtt-ca"
MODEL_VERSION = "0.1.0"

MAX_LENGTH_TO_BREADTH = 8.0  # cap on ellipse elongation at extreme wind speeds

# (d_col, d_row): 8 neighbours plus 8 "knight" moves; row increases northward.
_STENCIL = (
    (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1),
    (2, 1), (1, 2), (-1, 2), (-2, 1), (-2, -1), (-1, -2), (1, -2), (2, -1),
)


@dataclass(frozen=True)
class FireParams:
    base_spread_m_per_min: float  # no-wind, flat-ground spread rate on the uniform fuel
    wind_from_deg: float  # meteorological: direction the wind blows FROM, degrees clockwise from north
    wind_speed_m_s: float  # constant over the run; treated as a 10 m open wind
    wind_coef_per_m_s: float = 0.3  # head rate = base * (1 + wind_coef * wind_speed); dimensionless per (m/s)

    def __post_init__(self) -> None:
        for name, value in asdict(self).items():
            if not math.isfinite(value):
                raise ValueError(f"{name} must be finite, got {value}")
        for name in ("base_spread_m_per_min", "wind_speed_m_s", "wind_coef_per_m_s"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be nonnegative, got {getattr(self, name)}")

    def to_dict(self) -> dict:
        return {
            **asdict(self),
            "wind_from_deg": self.wind_from_deg % 360,
            "head_spread_m_per_min": self.head_rate_m_per_min,
            "length_to_breadth": self.length_to_breadth,
        }

    @property
    def head_rate_m_per_min(self) -> float:
        return self.base_spread_m_per_min * (1 + self.wind_coef_per_m_s * self.wind_speed_m_s)

    @property
    def length_to_breadth(self) -> float:
        """Alexander (1985) ellipse length-to-breadth ratio; wind in km/h, 1.0 when calm."""
        wind_kmh = self.wind_speed_m_s * 3.6
        return min(MAX_LENGTH_TO_BREADTH, 1 + 8.729 * (1 - math.exp(-0.030 * wind_kmh)) ** 2.155)

    def rate_m_per_min(self, bearing_deg: float) -> float:
        """Spread rate toward a compass bearing.

        Polar form of an ellipse about its rear focus: R(a) = R_head (1 - e) / (1 - e cos a),
        where a is the angle from the head direction (downwind) and e the eccentricity.
        """
        lb = self.length_to_breadth
        e = math.sqrt(1 - 1 / (lb * lb))
        heading = (self.wind_from_deg + 180) % 360
        a = math.radians(bearing_deg - heading)
        return self.head_rate_m_per_min * (1 - e) / (1 - e * math.cos(a))


def simulate_arrival(grid: Grid, ignition: bytearray, params: FireParams, horizon_s: float) -> list[float]:
    """Seconds after t0 at which each cell ignites; 0.0 for ignition cells, math.inf if not reached by horizon_s.

    Fire cannot leave the grid, so spread is truncated at the domain edge.
    """
    if len(ignition) != grid.size:
        raise ValueError(f"ignition mask has {len(ignition)} cells, grid has {grid.size}")
    if not (horizon_s >= 0):
        raise ValueError(f"horizon_s must be nonnegative, got {horizon_s}")
    ncols, nrows = grid.ncols, grid.nrows
    stencil = []
    for dc, dr in _STENCIL:
        rate = params.rate_m_per_min(math.degrees(math.atan2(dc, dr)))
        if rate > 0:
            cost_s = grid.cell_m * math.hypot(dc, dr) / rate * 60
            stencil.append((dc, dr, dr * ncols + dc, cost_s))
    arrival = [math.inf] * grid.size
    heap = []
    for i, burning in enumerate(ignition):
        if burning:
            arrival[i] = 0.0
            heap.append((0.0, i))
    heapq.heapify(heap)
    pop, push = heapq.heappop, heapq.heappush
    while heap:
        t, i = pop(heap)
        if t > arrival[i]:
            continue
        row, col = divmod(i, ncols)
        for dc, dr, delta, cost_s in stencil:
            c, r = col + dc, row + dr
            if 0 <= c < ncols and 0 <= r < nrows:
                nt = t + cost_s
                j = i + delta
                if nt < arrival[j] and nt <= horizon_s:
                    arrival[j] = nt
                    push(heap, (nt, j))
    return arrival


def burned_mask(arrival: list[float], t_s: float) -> bytearray:
    """Cumulative burned area at t_s seconds after t0."""
    return bytearray(1 if a <= t_s else 0 for a in arrival)
