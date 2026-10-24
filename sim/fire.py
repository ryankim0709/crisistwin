"""Fire spread solved as minimum travel time. Two models:

- `elliptical-mtt-ca` (FireParams, simulate_arrival): wind ellipse on uniform fuel, flat ground.
- `rothermel-mtt` (RothermelParams, simulate_arrival_rothermel): Rothermel (1972) surface spread on
  terrain with optional seeded spotting; see the section below.

elliptical-mtt-ca: each cell's arrival time is the shortest travel time from the ignition cells over a
16-neighbour stencil (Dijkstra). The spread rate along a stencil direction comes from
a fire ellipse with the ignition point at its rear focus. There is no terrain, fuel
variation, spotting, suppression, or time-varying weather; fuel is uniform everywhere.
"""

from __future__ import annotations

import heapq
import math
import random
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


# --- rothermel-mtt: Rothermel (1972) surface spread on terrain, solved as minimum travel time ---------------
#
# Spread rate from Rothermel (1972) with the Albini (1976) multi-class weighting, for one
# Scott & Burgan (2005) fuel model applied to every cell (the package has no fuel layer).
# Wind and slope effects are combined as vectors (Rothermel 1972; Albini 1976; Finney 1998,
# FARSITE), giving a per-cell head rate and direction; the fire shape is an ellipse from the
# effective midflame wind speed (Anderson 1983). Arrival times use the same 16-neighbour
# Dijkstra as elliptical-mtt-ca, with each step costing half its length at the source
# cell's rate and half at the target's. Optional spotting is a simple seeded rule, below.

ROTHERMEL_MODEL_ID = "rothermel-mtt"
ROTHERMEL_MODEL_VERSION = "0.1.0"

_TONS_PER_ACRE_TO_LB_PER_FT2 = 2000 / 43560
_FT_PER_MIN_TO_M_PER_MIN = 0.3048
_M_S_TO_FT_PER_MIN = 60 / 0.3048
_FT_PER_MIN_TO_MPH = 60 / 5280
_PARTICLE_DENSITY_LB_FT3 = 32.0  # Rothermel (1972) standard fuel particle density
_TOTAL_MINERAL = 0.0555
_EFFECTIVE_MINERAL = 0.010
_SAV_10H, _SAV_100H = 109.0, 30.0  # 1/ft, standard for all Scott & Burgan models
MAX_LENGTH_TO_BREADTH_ANDERSON = 8.0  # cap on Anderson (1983) elongation, as in FARSITE practice


@dataclass(frozen=True)
class FuelModel:
    """Scott & Burgan (2005) standard fire behavior fuel model; loads in tons/acre, SAV in 1/ft, depth in ft."""

    code: str
    load_1h: float
    load_10h: float
    load_100h: float
    load_herb: float
    load_woody: float
    sav_1h: float
    sav_herb: float
    sav_woody: float
    depth_ft: float
    dead_extinction_moisture: float  # fraction
    heat_btu_lb: float = 8000.0
    dynamic: bool = False  # herbaceous load transfers to dead as it cures
    waf_unsheltered: float = 0.4  # midflame wind adjustment factor for unsheltered fuel (Andrews 2012)


# Subset of Scott & Burgan (2005) Table 7 relevant to the Camp Fire foothills (brush, timber understory, litter).
FUEL_MODELS = {m.code: m for m in (
    FuelModel("GS2", 0.5, 0.5, 0.0, 0.6, 1.0, 2000, 1800, 1800, 1.5, 0.15, dynamic=True, waf_unsheltered=0.46),
    FuelModel("SH5", 3.6, 2.1, 0.0, 0.0, 2.9, 750, 0, 1600, 6.0, 0.15, waf_unsheltered=0.55),
    FuelModel("SH7", 3.5, 5.3, 2.2, 0.0, 3.4, 750, 0, 1600, 6.0, 0.15, waf_unsheltered=0.55),
    FuelModel("TU5", 4.0, 4.0, 3.0, 0.0, 3.0, 1500, 0, 750, 1.0, 0.25, waf_unsheltered=0.33),
    FuelModel("TL8", 5.8, 1.4, 1.1, 0.0, 0.0, 1800, 0, 0, 0.3, 0.35, waf_unsheltered=0.28),
)}

# Assumption: the package has no fuel layer. SH5 (high-load, dry-climate shrub) stands for the
# chaparral/manzanita brush of the Feather River canyon and Concow, where the day-1 run started,
# and for the brushy understory of the Paradise ridge pine-oak woodland.
DEFAULT_FUEL_MODEL = "SH5"

# Assumption: named dead/live fuel moisture scenarios (fractions) for 2018-11-08, consistent with the
# extreme fire weather (RH near 10 % or below, months without significant rain, cured herbaceous fuel).
# They are not observations; the package has no fuel moisture data.
MOISTURE_SCENARIOS = {
    "extreme": {"m1h": 0.03, "m10h": 0.04, "m100h": 0.05, "m_herb": 0.30, "m_woody": 0.60},
    "very_dry": {"m1h": 0.05, "m10h": 0.06, "m100h": 0.08, "m_herb": 0.30, "m_woody": 0.80},
}

# Spotting rule (off by default): each cell, when it ignites, throws one ember with probability
# spot_probability per SPOT_REFERENCE_CELL_M-sized cell (scaled by cell area on other grids); the ember lands at spot_distance_m * U(SPOT_DISTANCE_FRACTION) along the wind
# heading +/- U(SPOT_SPREAD_DEG) and ignites that cell SPOT_IGNITION_DELAY_MIN later if still unburned.
# It is a seeded stand-in for the long-range spotting that drove day-1 spread, not an ember transport model.
SPOT_DISTANCE_FRACTION = (0.5, 1.0)
SPOT_SPREAD_DEG = 15.0
SPOT_IGNITION_DELAY_MIN = 10.0
SPOT_REFERENCE_CELL_M = 200.0


@dataclass(frozen=True)
class RothermelParams:
    wind_from_deg: float  # meteorological direction the wind blows FROM, degrees clockwise from north
    wind_20ft_m_s: float  # 20-ft (6.1 m) open wind speed, constant over the run
    moisture: str = "extreme"  # key of MOISTURE_SCENARIOS
    fuel_model: str = DEFAULT_FUEL_MODEL
    waf: float | None = None  # midflame wind adjustment factor; None = the fuel model's unsheltered value
    spot_distance_m: float = 0.0  # 0 disables spotting
    spot_probability: float = 0.0
    seed: int = 7

    def __post_init__(self) -> None:
        if self.fuel_model not in FUEL_MODELS:
            raise ValueError(f"unknown fuel model {self.fuel_model}; known: {sorted(FUEL_MODELS)}")
        if self.moisture not in MOISTURE_SCENARIOS:
            raise ValueError(f"unknown moisture scenario {self.moisture}; known: {sorted(MOISTURE_SCENARIOS)}")
        for name in ("wind_from_deg", "wind_20ft_m_s", "spot_distance_m", "spot_probability"):
            if not math.isfinite(getattr(self, name)):
                raise ValueError(f"{name} must be finite")
        if self.wind_20ft_m_s < 0 or self.spot_distance_m < 0 or not 0 <= self.spot_probability <= 1:
            raise ValueError("wind speed and spot distance must be nonnegative and spot_probability in [0, 1]")
        if self.waf is not None and not 0 < self.waf <= 1:
            raise ValueError(f"waf must be in (0, 1], got {self.waf}")

    @property
    def spotting(self) -> bool:
        return self.spot_distance_m > 0 and self.spot_probability > 0

    @property
    def wind_adjustment(self) -> float:
        return self.waf if self.waf is not None else FUEL_MODELS[self.fuel_model].waf_unsheltered

    def to_dict(self) -> dict:
        fuel = rothermel_fuel(self)
        return {
            **asdict(self),
            "wind_from_deg": self.wind_from_deg % 360,
            "waf": self.wind_adjustment,
            "midflame_wind_m_s": round(self.wind_20ft_m_s * self.wind_adjustment, 2),
            "moisture_fractions": MOISTURE_SCENARIOS[self.moisture],
            "no_wind_no_slope_rate_m_per_min": round(fuel["r0_ft_min"] * _FT_PER_MIN_TO_M_PER_MIN, 2),
            "flat_head_rate_m_per_min": round(fuel["r0_ft_min"] * (1 + fuel["phi_w"]) * _FT_PER_MIN_TO_M_PER_MIN, 1),
            "reaction_intensity_btu_ft2_min": round(fuel["ir"]),
            "spotting": self.spotting,
            "spot_rule": {"distance_fraction": list(SPOT_DISTANCE_FRACTION), "spread_deg": SPOT_SPREAD_DEG,
                          "ignition_delay_min": SPOT_IGNITION_DELAY_MIN,
                          "probability_per_cell_m": SPOT_REFERENCE_CELL_M} if self.spotting else None,
        }


def rothermel_fuel(params: RothermelParams) -> dict:
    """Rothermel (1972) no-wind, no-slope spread rate and wind/slope coefficients for the fuel and moisture.

    Imperial units internally, as in the original equations. Returns r0_ft_min, ir (reaction
    intensity, BTU/ft2/min), phi_w for the run's midflame wind, and the coefficients C, B, E,
    beta_ratio and slope_k (phi_s = slope_k * tan^2).
    """
    fm = FUEL_MODELS[params.fuel_model]
    m = MOISTURE_SCENARIOS[params.moisture]
    lb = _TONS_PER_ACRE_TO_LB_PER_FT2
    herb_dead_share = 0.0
    if fm.dynamic:  # Scott & Burgan (2005): fully cured at <= 30 % herb moisture, uncured at >= 120 %
        herb_dead_share = min(1.0, max(0.0, (1.20 - m["m_herb"]) / 0.90))
    # (load lb/ft2, SAV 1/ft, moisture fraction) per size class
    dead = [(fm.load_1h * lb, fm.sav_1h, m["m1h"]), (fm.load_10h * lb, _SAV_10H, m["m10h"]),
            (fm.load_100h * lb, _SAV_100H, m["m100h"]), (fm.load_herb * herb_dead_share * lb, fm.sav_herb, m["m1h"])]
    live = [(fm.load_herb * (1 - herb_dead_share) * lb, fm.sav_herb, m["m_herb"]),
            (fm.load_woody * lb, fm.sav_woody, m["m_woody"])]
    dead = [c for c in dead if c[0] > 0]
    live = [c for c in live if c[0] > 0]

    def areas(classes):
        return [w * s / _PARTICLE_DENSITY_LB_FT3 for w, s, _ in classes]

    a_dead, a_live = sum(areas(dead)), sum(areas(live))
    a_total = a_dead + a_live
    categories = []  # (f_category, [(f_ij, w, sav, moisture)], extinction moisture)
    mx_dead = fm.dead_extinction_moisture
    mx_live = mx_dead
    if live:
        fine_dead = sum(w * math.exp(-138 / s) for w, s, _ in dead)
        fine_live = sum(w * math.exp(-500 / s) for w, s, _ in live)
        fine_dead_moisture = sum(w * math.exp(-138 / s) * mo for w, s, mo in dead) / fine_dead if fine_dead else 0
        mx_live = max(mx_dead, 2.9 * fine_dead / fine_live * (1 - fine_dead_moisture / mx_dead) - 0.226)
    for classes, total, mx in ((dead, a_dead, mx_dead), (live, a_live, mx_live)):
        if classes:
            categories.append((total / a_total, [(a / total, w, s, mo) for a, (w, s, mo) in zip(areas(classes), classes)], mx))

    sigma = sum(f_cat * sum(f * s for f, _, s, _ in cls) for f_cat, cls, _ in categories)
    bulk_density = sum(w for _, cls, _ in categories for _, w, _, _ in cls) / fm.depth_ft
    beta = bulk_density / _PARTICLE_DENSITY_LB_FT3
    beta_op = 3.348 * sigma ** -0.8189
    ratio = beta / beta_op
    gamma_max = sigma ** 1.5 / (495 + 0.0594 * sigma ** 1.5)
    a_exp = 133 * sigma ** -0.7913
    gamma = gamma_max * ratio ** a_exp * math.exp(a_exp * (1 - ratio))
    eta_s = min(1.0, 0.174 * _EFFECTIVE_MINERAL ** -0.19)
    ir = 0.0
    heat_sink = 0.0
    for f_cat, cls, mx in categories:
        net_load = sum(f * w for f, w, _, _ in cls) * (1 - _TOTAL_MINERAL)
        moisture = sum(f * mo for f, _, _, mo in cls)
        rm = min(1.0, moisture / mx)
        eta_m = max(0.0, 1 - 2.59 * rm + 5.11 * rm ** 2 - 3.52 * rm ** 3)
        ir += gamma * net_load * fm.heat_btu_lb * eta_m * eta_s
        heat_sink += f_cat * sum(f * math.exp(-138 / s) * (250 + 1116 * mo) for f, _, s, mo in cls)
    heat_sink *= bulk_density
    xi = math.exp((0.792 + 0.681 * sigma ** 0.5) * (beta + 0.1)) / (192 + 0.2595 * sigma)
    r0 = ir * xi / heat_sink
    c = 7.47 * math.exp(-0.133 * sigma ** 0.55)
    b = 0.02526 * sigma ** 0.54
    e = 0.715 * math.exp(-3.59e-4 * sigma)
    midflame_ft_min = params.wind_20ft_m_s * params.wind_adjustment * _M_S_TO_FT_PER_MIN
    # Rothermel's (1972) wind limit, 0.9 * IR in ft/min; rarely binding for these fuels.
    wind_limit = 0.9 * ir
    phi_w = c * min(midflame_ft_min, wind_limit) ** b * ratio ** -e
    return {"r0_ft_min": r0, "ir": ir, "phi_w": phi_w, "c": c, "b": b, "e": e, "beta_ratio": ratio,
            "slope_k": 5.275 * beta ** -0.3, "wind_limit_ft_min": wind_limit,
            "wind_limited": midflame_ft_min > wind_limit}


def _anderson_length_to_breadth(effective_midflame_mph: float) -> float:
    """Anderson (1983) length-to-breadth from effective midflame wind speed (mph), capped."""
    u = effective_midflame_mph
    lb = 0.936 * math.exp(0.2566 * u) + 0.461 * math.exp(-0.1548 * u) - 0.397
    return min(MAX_LENGTH_TO_BREADTH_ANDERSON, max(1.0, lb))


def rothermel_cell_rates(params: RothermelParams, slope_tan: list[float] | None, upslope_deg: list[float] | None,
                         size: int) -> list[tuple[float, float, float]]:
    """(head rate m/min, eccentricity, head bearing deg) per cell from the wind + slope vector sum."""
    fuel = rothermel_fuel(params)
    r0, phi_w, c, b, e_coef = fuel["r0_ft_min"], fuel["phi_w"], fuel["c"], fuel["b"], fuel["e"]
    ratio_e = fuel["beta_ratio"] ** e_coef
    heading = math.radians((params.wind_from_deg + 180) % 360)
    wx, wy = phi_w * math.sin(heading), phi_w * math.cos(heading)
    cache: dict[tuple[float, float], tuple[float, float, float]] = {}
    out = []
    for i in range(size):
        tan = slope_tan[i] if slope_tan else 0.0
        up = upslope_deg[i] if upslope_deg else 0.0
        key = (round(tan, 3), round(up))
        cell = cache.get(key)
        if cell is None:
            phi_s = fuel["slope_k"] * key[0] ** 2
            x = wx + phi_s * math.sin(math.radians(key[1]))
            y = wy + phi_s * math.cos(math.radians(key[1]))
            phi_e = math.hypot(x, y)
            head = r0 * (1 + phi_e) * _FT_PER_MIN_TO_M_PER_MIN
            effective_ft_min = (phi_e * ratio_e / c) ** (1 / b) if phi_e > 0 else 0.0
            lb = _anderson_length_to_breadth(effective_ft_min * _FT_PER_MIN_TO_MPH)
            ecc = math.sqrt(1 - 1 / (lb * lb))
            bearing = math.degrees(math.atan2(x, y)) % 360 if phi_e > 0 else 0.0
            cell = cache[key] = (head, ecc, bearing)
        out.append(cell)
    return out


def simulate_arrival_rothermel(grid: Grid, ignition: bytearray, params: RothermelParams, horizon_s: float,
                               terrain=None) -> list[float]:
    """Seconds after t0 at which each cell ignites (rothermel-mtt); 0.0 for ignition cells, math.inf if not
    reached by horizon_s. `terrain` is a sim.terrain.Terrain on the same grid, or None for flat ground.

    Spotting, when enabled, draws from random.Random(params.seed) in Dijkstra pop order, so a run is
    reproducible for the same inputs.
    """
    if len(ignition) != grid.size:
        raise ValueError(f"ignition mask has {len(ignition)} cells, grid has {grid.size}")
    if not (horizon_s >= 0):
        raise ValueError(f"horizon_s must be nonnegative, got {horizon_s}")
    if terrain is not None and terrain.grid != grid:
        raise ValueError("terrain must be resampled to the simulation grid")
    ncols, nrows = grid.ncols, grid.nrows
    cells = rothermel_cell_rates(params, terrain.slope_tan if terrain else None,
                                 terrain.upslope_deg if terrain else None, grid.size)
    # Half-step travel time (s) per stencil direction and cell; a step costs half[i] + half[j].
    stencil = []
    for dc, dr in _STENCIL:
        bearing = math.atan2(dc, dr)
        half_m = grid.cell_m * math.hypot(dc, dr) / 2
        half = [half_m * 60 * (1 - ecc * math.cos(bearing - math.radians(head_bearing))) / (head * (1 - ecc))
                for head, ecc, head_bearing in cells]
        stencil.append((dc, dr, dr * ncols + dc, half))
    arrival = [math.inf] * grid.size
    heap = []
    for i, burning in enumerate(ignition):
        if burning:
            arrival[i] = 0.0
            heap.append((0.0, i))
    heapq.heapify(heap)
    pop, push = heapq.heappop, heapq.heappush
    rng = random.Random(params.seed)
    spotting = params.spotting
    spot_probability = min(1.0, params.spot_probability * (grid.cell_m / SPOT_REFERENCE_CELL_M) ** 2)
    spot_heading = (params.wind_from_deg + 180) % 360
    spot_delay_s = SPOT_IGNITION_DELAY_MIN * 60
    while heap:
        t, i = pop(heap)
        if t > arrival[i]:
            continue
        row, col = divmod(i, ncols)
        for dc, dr, delta, half in stencil:
            c, r = col + dc, row + dr
            if 0 <= c < ncols and 0 <= r < nrows:
                j = i + delta
                nt = t + half[i] + half[j]
                if nt < arrival[j] and nt <= horizon_s:
                    arrival[j] = nt
                    push(heap, (nt, j))
        if spotting and rng.random() < spot_probability:
            dist = params.spot_distance_m * rng.uniform(*SPOT_DISTANCE_FRACTION) / grid.cell_m
            bearing = math.radians(spot_heading + rng.uniform(-SPOT_SPREAD_DEG, SPOT_SPREAD_DEG))
            c = math.floor(col + 0.5 + dist * math.sin(bearing))
            r = math.floor(row + 0.5 + dist * math.cos(bearing))
            if 0 <= c < ncols and 0 <= r < nrows:
                j = r * ncols + c
                nt = t + spot_delay_s
                if nt < arrival[j] and nt <= horizon_s:
                    arrival[j] = nt
                    push(heap, (nt, j))
    return arrival
