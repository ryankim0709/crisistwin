"""Empirical ground-data rates (911, radio, rescue) from the 2018 Camp Fire record.

Calibration input for a future generator of synthetic 911 calls, radio traffic and rescue
requests. Standard library only; it reads two files and touches nothing else:

- ``tools/camp_ground_record.json``: 605 de-identified NIST TN 2252 / TN 2252sup rows
  (Table A-2 911 and radio-log rows, Table K-1 rescue events, main Tables 10 and 13);
- ``app/public/replays/camp-2018.json``: the replay bundle (block-group zones, the modelled
  ``rothermel-mtt`` arrival grid, NIST fire observations, historical events).

Conventions (see docs/ground-data-calibration.md):

- Time: every timestamp is aware UTC. The source clock was Pacific Standard Time
  (UTC-08:00 on 2018-11-08/09); the record already converted it (``at`` = PST + 8 h).
  Offsets are in minutes (``*_min``), rates in events per 1,000 households per hour.
- Distance: metres (``*_m``) in the bundle grid's local equirectangular projection.
- Coordinates: GeoJSON order (longitude, latitude), EPSG:4326.
- Every output is derived from observed (``reported``) or ``reconstructed`` rows and from
  ``simulated`` model fields; which basis a number uses is named next to it.

Nothing here is a forecast or an operational rate; it describes one sampled record.
"""

from __future__ import annotations

import bisect
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sim.geo import Grid, point_in_geometry, rasterize

ROOT = Path(__file__).resolve().parents[1]
RECORD_PATH = ROOT / "tools" / "camp_ground_record.json"
BUNDLE_PATH = ROOT / "app" / "public" / "replays" / "camp-2018.json"

MODEL_VERSION = "ground-rates-1"

# --- Named constants and assumptions -------------------------------------------------------

# Source clock offset, documented in the record header ("time_conversion"): at = PST + 8 h.
SOURCE_UTC_OFFSET_H = -8

# Channels with per-zone geolocated rows. "notification" and "evacuation" rows come from
# NIST summary Tables 10 and 13 and carry no coordinates, so they are not rate-modelled.
RATE_CHANNELS = ("911", "radio", "rescue")
MIX_CATEGORIES = ("help_needed", "trapped", "fire_seen", "road_blocked", "heavy_traffic")

# Histogram of (row time - zone fire arrival): bin width and range, minutes. Assumption.
OFFSET_BIN_MIN = 30
OFFSET_RANGE_MIN = (-240, 600)

# Rate model unit: zone x one UTC hour. The first bin starts at the bundle clock start
# (2018-11-08T14:00Z, which is 06:00 PST); ignition is 14:20Z (NIST TN 2252 Sec. 1.2).
RATE_BIN_MIN = 60

# Distance bands for the zone-centroid distance to the modelled fire front, metres.
# Assumption chosen before fitting (round numbers); the last band includes "not reached".
DISTANCE_BAND_EDGES_M = (2_000.0, 5_000.0)
DISTANCE_BANDS = ("fire_in_zone", "lt_2km", "2_5km", "ge_5km_or_unreached")
# The GLM merges lt_2km and 2_5km: on Camp the modelled front crosses a zone's 0-2 km ring
# within one hour, leaving lt_2km about 1% of exposure (post-hoc merge, see the docs).
GLM_BAND_MERGE = {"lt_2km": "lt_5km", "2_5km": "lt_5km"}
GLM_DISTANCE_BANDS = ("fire_in_zone", "lt_5km", "ge_5km_or_unreached")
# Phases relative to the zone's first evacuation order (bundle insights.zones.order_at),
# hours. Assumption chosen before fitting.
ORDER_PHASE_EDGES_H = (0.0, 2.0)
ORDER_PHASES = ("before_order", "order_0_2h", "order_ge_2h")

# Seeded resampling for confidence intervals (percentile bootstrap).
BOOTSTRAP_SEED = 20181108
BOOTSTRAP_RESAMPLES = 2000
Z_95 = 1.959963984540054  # standard normal 97.5th percentile

# Fire observations whose source is itself a 911 call or the radio log are excluded from the
# observed zone arrival, so the arrival is not derived from the rows being timed against it.
OBSERVATION_SOURCE_EXCLUDE = ("911", "Radio")

# A row coordinate representable at 2 decimals may have been coarsened to ~1 km (record
# header "coordinate_precision"); at 3 decimals it is ~100 m. A 3-decimal point that ends in
# 0 also looks 2-decimal, so the count is an upper bound.
COARSE_COORD_DECIMALS = 2

# External volume figure for the 911 scaling (not in the record):
# San Francisco Chronicle, "Camp Fire 911 calls: As flames raced in, ..." (2019-01-20),
# review of Paradise Police dispatch audio: "at least 132" 911 calls answered between
# 06:30 and 08:20 PST, when calls were rerouted to Chico.
# https://www.sfchronicle.com/california-wildfires/article/Camp-Fire-911-calls-As-flames-raced-in-13541139.php
PPD_911_CALLS_AT_LEAST = 132
PPD_911_WINDOW_UTC = ("2018-11-08T14:30:00Z", "2018-11-08T16:20:00Z")  # 06:30-08:20 PST
PPD_911_SOURCE = ("San Francisco Chronicle 2019-01-20, Paradise Police dispatch audio review; "
                  "'at least 132' calls 06:30-08:20 PST (14:30-16:20Z)")

# Match radius between a radio road_blocked row and a modelled road closure on the same
# named road, metres. Assumption (about 10x the 3-decimal coordinate rounding).
ROAD_MATCH_RADIUS_M = 1_000.0


# --- Parameters exposed to a generator ----------------------------------------------------

@dataclass(frozen=True)
class RateFit:
    """Poisson log-linear rate model for one channel, fitted by IRLS (no external libraries).

    rate (events per 1,000 households per hour) = exp(intercept + sum of active coefficients);
    reference levels are GLM_DISTANCE_BANDS[-1] and ORDER_PHASES[0].
    """

    channel: str
    window_utc: tuple[str, str]
    n_units: int  # zone-hour cells
    n_events: int  # geolocated rows inside a zone and the window
    exposure_khh_h: float  # 1,000-household-hours
    terms: tuple[str, ...]
    coef: tuple[float, ...]
    se_poisson: tuple[float, ...]
    se_quasi: tuple[float, ...]  # se_poisson * sqrt(dispersion)
    estimable: tuple[bool, ...]  # False where a level has no events (coefficient diverges)
    deviance: float
    null_deviance: float
    pseudo_r2: float  # 1 - deviance / null_deviance
    dispersion: float  # Pearson chi2 / (n - p); >> 1 means overdispersed
    converged: bool


@dataclass(frozen=True)
class GroundRateParams:
    """Everything a generator needs, with the basis of each number named.

    Times are minutes; rates are per 1,000 households per hour; all clocks are UTC.
    Mapping-like fields are tuples of pairs so the dataclass stays hashable and frozen.
    """

    model_version: str
    time_zone: str
    arrival_basis: str
    distance_basis: str
    order_basis: str
    # Q1: offset (row time - zone fire arrival) summary per channel, observed arrival basis:
    # (channel, n, median_min, ci95_lo_min, ci95_hi_min, q25_min, q75_min)
    offset_summary_observed: tuple[tuple[str, int, float, float, float, float, float], ...]
    offset_summary_modelled: tuple[tuple[str, int, float, float, float, float, float], ...]
    offset_hist_bin_min: int
    # (channel, ((bin_start_min, count), ...)), observed arrival basis
    offset_hist_observed: tuple[tuple[str, tuple[tuple[int, int], ...]], ...]
    # Q2
    rate_fits: tuple[RateFit, ...]
    # (channel, distance_band, order_phase, events, exposure_khh_h, rate, ci_lo, ci_hi)
    empirical_rates: tuple[tuple[str, str, str, int, float, float, float, float], ...]
    # Q3: (channel, phase, ((category, share), ...), n) with phase in before/after arrival
    category_mix: tuple[tuple[str, str, tuple[tuple[str, float], ...], int], ...]
    road_report_lag_vs_model_min: tuple[int, float | None, float | None, float | None]  # n, median, q25, q75
    # Q4
    radio_to_911_ratio: float | None
    radio_to_911_ratio_ci95: tuple[float, float] | None
    radio_to_911_window_utc: tuple[str, str]
    rescue_minus_first_911_by_zone_min: tuple[int, float | None, float | None, float | None]
    rescue_rows_coinciding_with_911: tuple[int, int]  # (rescue rows with coord, coinciding)
    # Q5
    record_911_rows: int
    record_911_distinct_calls: int
    record_911_calls_in_ppd_window: int
    ppd_911_calls_at_least: int
    scale_911_at_least: float | None  # multiply record 911 call counts by at least this
    scale_911_source: str
    notes: tuple[str, ...] = field(default_factory=tuple)
    # Q4, restricted to rescue rows inside radio_to_911_window_utc (the 911 sample's coverage),
    # where a coinciding 911 row can exist: (rescue rows with coord, coinciding).
    rescue_rows_coinciding_with_911_in_window: tuple[int, int] = (0, 0)

    def to_dict(self) -> dict:
        return asdict(self)


# --- Loading --------------------------------------------------------------------------------

def parse_utc(value: str) -> datetime:
    if not value.endswith("Z"):
        raise ValueError(f"expected a UTC timestamp ending in Z: {value!r}")
    return datetime.fromisoformat(value[:-1]).replace(tzinfo=timezone.utc)


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path | str) -> dict:
    return json.loads(Path(path).read_text())


@dataclass
class Zone:
    id: str
    households: int
    geometry: dict
    bbox: tuple[float, float, float, float]
    centroid_lonlat: tuple[float, float]
    order_at: datetime | None
    modelled_arrival_at: datetime | None
    observed_arrival_at: datetime | None = None
    observed_arrival_n: int = 0
    # Cells of the arrival grid sorted by arrival, with the running minimum distance from the
    # zone centroid: front distance at time t is the value at the last cell reached by t.
    _arrival_min: list[float] = field(default_factory=list, repr=False)
    _prefix_dist_m: list[float] = field(default_factory=list, repr=False)

    def front_distance_m(self, minutes_since_t0: float) -> float | None:
        """Centroid distance to the nearest modelled burning cell, or None if none burns yet."""
        i = bisect.bisect_right(self._arrival_min, minutes_since_t0)
        return self._prefix_dist_m[i - 1] if i else None


def _bbox(geometry: dict) -> tuple[float, float, float, float]:
    rings = geometry["coordinates"] if geometry["type"] == "Polygon" else [r for p in geometry["coordinates"] for r in p]
    xs = [pt[0] for ring in rings for pt in ring]
    ys = [pt[1] for ring in rings for pt in ring]
    return min(xs), min(ys), max(xs), max(ys)


def arrival_grid(bundle: dict) -> tuple[Grid, list[float | None], datetime]:
    """The bundle's modelled arrival grid (minutes after t0; None = not reached)."""
    g = bundle["fire_simulated"]["arrival_grid"]
    grid = Grid(origin_lon=g["origin_lon"], origin_lat=g["origin_lat"], cell_m=g["cell_m"],
                ncols=g["ncols"], nrows=g["nrows"])
    return grid, g["minutes"], parse_utc(g["t0"])


def load_zones(bundle: dict) -> list[Zone]:
    """Block-group zones with households, order time, modelled and observed fire arrival."""
    insight = {z["zone_id"]: z for z in bundle["insights"]["zones"]}
    grid, minutes, _ = arrival_grid(bundle)
    reached = sorted((m, i) for i, m in enumerate(minutes) if m is not None)
    zones = []
    for feature in bundle["zones"]["features"]:
        zid = feature["id"]
        info = insight.get(zid, {})
        mask = rasterize(grid, feature["geometry"])
        cells = [i for i, inside in enumerate(mask) if inside]
        if cells:
            cx = statistics.fmean((i % grid.ncols + 0.5) * grid.cell_m for i in cells)
            cy = statistics.fmean((i // grid.ncols + 0.5) * grid.cell_m for i in cells)
            centroid = grid.to_lonlat(cx, cy)
        else:
            b = _bbox(feature["geometry"])
            centroid = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
            cx, cy = grid.to_xy(*centroid)
        zone = Zone(
            id=zid, households=int(feature["households"]), geometry=feature["geometry"],
            bbox=_bbox(feature["geometry"]), centroid_lonlat=centroid,
            order_at=parse_utc(info["order_at"]) if info.get("order_at") else None,
            modelled_arrival_at=parse_utc(info["fire_arrival_at"]) if info.get("fire_arrival_at") else None,
        )
        best = math.inf
        for m, i in reached:
            x = (i % grid.ncols + 0.5) * grid.cell_m
            y = (i // grid.ncols + 0.5) * grid.cell_m
            best = min(best, math.hypot(x - cx, y - cy))
            zone._arrival_min.append(float(m))
            zone._prefix_dist_m.append(best)
        zones.append(zone)
    _attach_observed_arrival(bundle, zones)
    return zones


def _observation_excluded(feature: dict) -> bool:
    source = feature.get("source_locator", "").split(";")[-1].strip()
    return any(source.startswith(p) for p in OBSERVATION_SOURCE_EXCLUDE)


def _attach_observed_arrival(bundle: dict, zones: list[Zone]) -> None:
    """Observed arrival = earliest non-residual NIST fire observation inside the zone.

    NIST observations show fire present at a time, not first arrival (bundle notes), so this
    is a late-biased estimate of arrival, more so in zones with few observations.
    """
    for feature in bundle["fire_observations"]["features"]:
        if feature.get("residual_fire") or _observation_excluded(feature):
            continue
        zone = assign_zone(feature["coord"][0], feature["coord"][1], zones)
        if zone is None:
            continue
        at = parse_utc(feature["at"])
        zone.observed_arrival_n += 1
        if zone.observed_arrival_at is None or at < zone.observed_arrival_at:
            zone.observed_arrival_at = at


def assign_zone(lon: float, lat: float, zones: list[Zone]) -> Zone | None:
    for zone in zones:
        x0, y0, x1, y1 = zone.bbox
        if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_geometry(lon, lat, zone.geometry):
            return zone
    return None


def is_coarse(coord: list[float] | None) -> bool:
    return coord is not None and all(round(v, COARSE_COORD_DECIMALS) == v for v in coord)


# --- Small statistics helpers --------------------------------------------------------------

def quantile(values: list[float], q: float) -> float:
    """Linear-interpolation quantile (Hyndman & Fan type 7, the numpy default)."""
    xs = sorted(values)
    if not xs:
        raise ValueError("empty")
    pos = (len(xs) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def bootstrap_ci(values: list[float], stat=statistics.median, *, seed: int = BOOTSTRAP_SEED,
                 resamples: int = BOOTSTRAP_RESAMPLES) -> tuple[float, float]:
    """Percentile bootstrap 95% interval (Efron & Tibshirani 1993, ch. 13), seeded."""
    rng = random.Random(seed)
    n = len(values)
    stats = sorted(stat([values[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples))
    return quantile(stats, 0.025), quantile(stats, 0.975)


def poisson_ci(count: int) -> tuple[float, float]:
    """95% interval for a Poisson count: Byar's approximation (Breslow & Day 1987, vol. II,
    eq. 2.12); exact upper bound -ln(0.025) for a zero count."""
    if count == 0:
        return 0.0, -math.log(0.025)
    lo = count * (1 - 1 / (9 * count) - Z_95 / (3 * math.sqrt(count))) ** 3
    c1 = count + 1
    hi = c1 * (1 - 1 / (9 * c1) + Z_95 / (3 * math.sqrt(c1))) ** 3
    return lo, hi


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Gauss-Jordan elimination with partial pivoting."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-300:
            raise ZeroDivisionError("singular matrix")
        m[col], m[piv] = m[piv], m[col]
        p = m[col][col]
        m[col] = [v / p for v in m[col]]
        for r in range(n):
            if r != col and m[r][col]:
                f = m[r][col]
                m[r] = [vr - f * vc for vr, vc in zip(m[r], m[col])]
    return [m[i][n] for i in range(n)]


def _inverse(a: list[list[float]]) -> list[list[float]]:
    n = len(a)
    cols = [_solve(a, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def poisson_deviance(y: list[float], mu: list[float]) -> float:
    return 2 * sum((yi * math.log(yi / mi) if yi > 0 else 0.0) - (yi - mi) for yi, mi in zip(y, mu))


def fit_poisson_glm(x: list[list[float]], y: list[float], offset: list[float], *,
                    max_iter: int = 100, tol: float = 1e-10) -> dict:
    """Poisson GLM with log link by iteratively reweighted least squares
    (McCullagh & Nelder 1989, Generalized Linear Models, 2nd ed., sec. 2.5)."""
    n, p = len(y), len(x[0])
    mean_rate = sum(y) / sum(math.exp(o) for o in offset)
    beta = [math.log(max(mean_rate, 1e-12))] + [0.0] * (p - 1)
    dev_old = math.inf
    converged = False
    for _ in range(max_iter):
        eta = [sum(b * xi for b, xi in zip(beta, row)) + o for row, o in zip(x, offset)]
        mu = [math.exp(min(e, 700)) for e in eta]
        z = [e - o + (yi - mi) / mi for e, o, yi, mi in zip(eta, offset, y, mu)]
        xtwx = [[sum(mu[k] * x[k][i] * x[k][j] for k in range(n)) for j in range(p)] for i in range(p)]
        xtwz = [sum(mu[k] * x[k][i] * z[k] for k in range(n)) for i in range(p)]
        beta = _solve(xtwx, xtwz)
        mu = [math.exp(min(sum(b * xi for b, xi in zip(beta, row)) + o, 700)) for row, o in zip(x, offset)]
        dev = poisson_deviance(y, mu)
        if abs(dev - dev_old) < tol * (1 + abs(dev)):
            converged = True
            break
        dev_old = dev
    xtwx = [[sum(mu[k] * x[k][i] * x[k][j] for k in range(n)) for j in range(p)] for i in range(p)]
    cov = _inverse(xtwx)
    pearson = sum((yi - mi) ** 2 / mi for yi, mi in zip(y, mu))
    mu0 = [math.exp(o) * sum(y) / sum(math.exp(o2) for o2 in offset) for o in offset]
    return {
        "beta": beta, "se": [math.sqrt(max(cov[i][i], 0.0)) for i in range(p)], "mu": mu,
        "deviance": dev, "null_deviance": poisson_deviance(y, mu0),
        "dispersion": pearson / max(n - p, 1), "converged": converged,
    }


# --- Analysis -------------------------------------------------------------------------------

@dataclass(frozen=True)
class Row:
    id: str
    at: datetime
    channel: str
    category: str
    road_name: str | None
    coord: tuple[float, float] | None
    coarse: bool
    zone_id: str | None
    source_id: str  # Table A-2 source (e.g. "911-014-1"), K-1 event, or table row


def load_rows(record: dict, zones: list[Zone]) -> list[Row]:
    rows = []
    for item in record["items"]:
        coord = item["coord"]
        zone = assign_zone(coord[0], coord[1], zones) if coord else None
        rows.append(Row(
            id=item["id"], at=parse_utc(item["at"]), channel=item["channel"], category=item["category"],
            road_name=item["road_name"], coord=tuple(coord) if coord else None, coarse=is_coarse(coord),
            zone_id=zone.id if zone else None,
            source_id=item["source_locator"].split(";")[-1].strip().removeprefix("source ").strip(),
        ))
    return rows


def offsets_min(rows: list[Row], zones: dict[str, Zone], basis: str) -> list[tuple[Row, float]]:
    """(row, minutes from the zone's fire arrival) for rows in a zone with an arrival."""
    out = []
    for row in rows:
        zone = zones.get(row.zone_id) if row.zone_id else None
        arrival = None if zone is None else (zone.observed_arrival_at if basis == "observed" else zone.modelled_arrival_at)
        if arrival is not None:
            out.append((row, (row.at - arrival).total_seconds() / 60))
    return out


def offset_summary(pairs: list[tuple[Row, float]], channel: str) -> tuple:
    vals = [d for r, d in pairs if r.channel == channel]
    if len(vals) < 3:
        return (channel, len(vals), math.nan, math.nan, math.nan, math.nan, math.nan)
    lo, hi = bootstrap_ci(vals)
    return (channel, len(vals), statistics.median(vals), lo, hi, quantile(vals, 0.25), quantile(vals, 0.75))


def offset_histogram(pairs: list[tuple[Row, float]], key) -> dict:
    lo, hi = OFFSET_RANGE_MIN
    hist: dict = defaultdict(Counter)
    for row, d in pairs:
        b = max(lo - OFFSET_BIN_MIN, min(hi, math.floor(d / OFFSET_BIN_MIN) * OFFSET_BIN_MIN))
        hist[key(row)][b] += 1
    return hist


def channel_window(rows: list[Row], channel: str) -> tuple[datetime, datetime]:
    """[first row hour floor, last row hour ceil) for a channel: data-defined coverage."""
    ts = [r.at for r in rows if r.channel == channel]
    start = min(ts).replace(minute=0, second=0, microsecond=0)
    end = max(ts).replace(minute=0, second=0, microsecond=0) + timedelta(minutes=RATE_BIN_MIN)
    return start, end


def distance_band(zone: Zone, at: datetime, t0: datetime) -> str:
    if zone.modelled_arrival_at is not None and at >= zone.modelled_arrival_at:
        return DISTANCE_BANDS[0]
    d = zone.front_distance_m((at - t0).total_seconds() / 60)
    if d is None or d >= DISTANCE_BAND_EDGES_M[1]:
        return DISTANCE_BANDS[3]
    return DISTANCE_BANDS[1] if d < DISTANCE_BAND_EDGES_M[0] else DISTANCE_BANDS[2]


def order_phase(zone: Zone, at: datetime) -> str:
    if zone.order_at is None or at < zone.order_at:
        return ORDER_PHASES[0]
    hours = (at - zone.order_at).total_seconds() / 3600
    return ORDER_PHASES[1] if hours < ORDER_PHASE_EDGES_H[1] else ORDER_PHASES[2]


def zone_hour_units(rows: list[Row], zones: list[Zone], channel: str, t0: datetime) -> list[dict]:
    """One unit per zone and UTC hour in the channel window; covariates at the bin midpoint."""
    start, end = channel_window(rows, channel)
    counts = Counter()
    for r in rows:
        if r.channel == channel and r.zone_id and start <= r.at < end:
            counts[(r.zone_id, int((r.at - start).total_seconds() // (RATE_BIN_MIN * 60)))] += 1
    units = []
    n_bins = int((end - start).total_seconds() // (RATE_BIN_MIN * 60))
    for zone in zones:
        for k in range(n_bins):
            mid = start + timedelta(minutes=RATE_BIN_MIN * (k + 0.5))
            units.append({
                "zone_id": zone.id, "bin": k, "y": counts[(zone.id, k)],
                "exposure_khh_h": zone.households / 1000 * RATE_BIN_MIN / 60,
                "band": distance_band(zone, mid, t0), "phase": order_phase(zone, mid),
            })
    return units


def fit_channel(rows: list[Row], zones: list[Zone], channel: str, t0: datetime) -> tuple[RateFit, list[dict]]:
    units = [u for u in zone_hour_units(rows, zones, channel, t0) if u["exposure_khh_h"] > 0]
    terms = ("intercept", *(f"band:{b}" for b in GLM_DISTANCE_BANDS[:-1]), *(f"phase:{p}" for p in ORDER_PHASES[1:]))
    x = [[1.0, *(1.0 if GLM_BAND_MERGE.get(u["band"], u["band"]) == b else 0.0 for b in GLM_DISTANCE_BANDS[:-1]),
          *(1.0 if u["phase"] == p else 0.0 for p in ORDER_PHASES[1:])] for u in units]
    # A level with no units would make X'WX singular; a level with no events diverges.
    present = [any(row[j] for row in x) for j in range(len(terms))]
    keep = [j for j in range(len(terms)) if present[j]]
    events_by_term = [sum(u["y"] for u, row in zip(units, x) if row[j]) for j in range(len(terms))]
    xk = [[row[j] for j in keep] for row in x]
    fit = fit_poisson_glm(xk, [float(u["y"]) for u in units], [math.log(u["exposure_khh_h"]) for u in units])
    coef = [math.nan] * len(terms)
    se = [math.nan] * len(terms)
    for idx, j in enumerate(keep):
        coef[j], se[j] = fit["beta"][idx], fit["se"][idx]
    estimable = tuple(present[j] and (j == 0 or events_by_term[j] > 0) for j in range(len(terms)))
    start, end = channel_window(rows, channel)
    rf = RateFit(
        channel=channel, window_utc=(format_utc(start), format_utc(end)), n_units=len(units),
        n_events=sum(u["y"] for u in units), exposure_khh_h=sum(u["exposure_khh_h"] for u in units),
        terms=terms, coef=tuple(coef), se_poisson=tuple(se),
        se_quasi=tuple(s * math.sqrt(fit["dispersion"]) for s in se), estimable=estimable,
        deviance=fit["deviance"], null_deviance=fit["null_deviance"],
        pseudo_r2=1 - fit["deviance"] / fit["null_deviance"] if fit["null_deviance"] > 0 else math.nan,
        dispersion=fit["dispersion"], converged=fit["converged"],
    )
    return rf, units


def empirical_rate_table(units: list[dict], channel: str) -> list[tuple]:
    cells: dict = defaultdict(lambda: [0, 0.0])
    for u in units:
        c = cells[(u["band"], u["phase"])]
        c[0] += u["y"]
        c[1] += u["exposure_khh_h"]
    out = []
    for b in DISTANCE_BANDS:
        for p in ORDER_PHASES:
            if (b, p) not in cells:
                continue
            y, e = cells[(b, p)]
            lo, hi = poisson_ci(y)
            out.append((channel, b, p, y, e, y / e, lo / e, hi / e))
    return out


def category_mix(rows: list[Row], zones: dict[str, Zone], channel: str) -> list[tuple]:
    """Category shares before and after the zone's observed fire arrival (MIX_CATEGORIES + other)."""
    out = []
    pairs = offsets_min([r for r in rows if r.channel == channel], zones, "observed")
    for phase, keep in (("before_arrival", lambda d: d < 0), ("after_arrival", lambda d: d >= 0)):
        cats = Counter(r.category if r.category in MIX_CATEGORIES else "other" for r, d in pairs if keep(d))
        n = sum(cats.values())
        shares = tuple((c, cats[c] / n if n else math.nan) for c in (*MIX_CATEGORIES, "other"))
        out.append((channel, phase, shares, n))
    return out


def category_by_hour(rows: list[Row], channel: str) -> dict[datetime, Counter]:
    hist: dict = defaultdict(Counter)
    for r in rows:
        if r.channel == channel:
            hist[r.at.replace(minute=0, second=0, microsecond=0)][
                r.category if r.category in MIX_CATEGORIES else "other"] += 1
    return dict(sorted(hist.items()))


def _norm_road(name: str) -> str:
    n = name.lower().replace(" road", "").replace(" rd", "").strip()
    return n


def road_report_lags(rows: list[Row], bundle: dict) -> dict:
    """Radio road_blocked rows vs (a) the bundle's non-simulated road_blocked/road_closed events
    and (b) the earliest modelled (simulated) road closure on the same named road within
    ROAD_MATCH_RADIUS_M of the row. Lag = row time - event time, minutes."""
    edges = {e["id"]: e for e in bundle["roads"]["edges"]}
    grid, _, _ = arrival_grid(bundle)
    radio = [r for r in rows if r.channel == "radio" and r.category == "road_blocked"]
    events = bundle["events"]
    hist_events = [e for e in events if e["type"] in ("road_blocked", "road_closed") and e["evidence_class"] != "simulated"]
    sim_closures = [e for e in events if e["type"] == "road_closed" and e["evidence_class"] == "simulated"]

    same_source = []
    for e in hist_events:
        tag = e["id"].split("-")[3].upper() if e["id"].startswith("nist-a2-") else ""  # e.g. "TD030"
        at = parse_utc(e["at"])
        hits = [r for r in rows if tag and r.source_id.replace("-", "").upper().startswith(tag)
                and abs((r.at - at).total_seconds()) <= 60]
        # Nearest radio road_blocked row on a road named in the event label (signed lag, min).
        label = e["label"].lower().replace(" rd", " road")
        named = [r for r in radio if r.road_name and _norm_road(r.road_name) in label]
        nearest = min(((r.at - at).total_seconds() / 60 for r in named), key=abs, default=None)
        same_source.append((e["id"], e["evidence_class"], tuple(sorted({f"{r.channel}:{r.category}" for r in hits})),
                            nearest))

    lags, unmatched = [], []
    for r in radio:
        if not r.road_name:
            unmatched.append((r.id, "no road name"))
            continue
        target = _norm_road(r.road_name)
        best = None
        for e in sim_closures:
            for eid in e["target"]["edge_ids"]:
                edge = edges.get(eid)
                if not edge or not edge.get("name") or not _norm_road(edge["name"]).startswith(target):
                    continue
                if r.coord is not None:
                    lon, lat = edge["coords"][len(edge["coords"]) // 2]
                    x0, y0 = grid.to_xy(lon, lat)
                    x1, y1 = grid.to_xy(*r.coord)
                    if math.hypot(x1 - x0, y1 - y0) > ROAD_MATCH_RADIUS_M:
                        continue
                at = parse_utc(e["at"])
                if best is None or at < best:
                    best = at
                break
        if best is None:
            unmatched.append((r.id, "no modelled closure on that road nearby"))
        else:
            lags.append((r.id, (r.at - best).total_seconds() / 60))
    return {"n_radio_road_blocked": len(radio), "historical_events": same_source,
            "lags_vs_model": lags, "unmatched": unmatched}


def radio_911_ratio(rows: list[Row]) -> tuple[float | None, tuple[float, float] | None, tuple[datetime, datetime], int, int]:
    """Ratio of radio rows to 911 rows inside the 911 coverage window (first to last 911 row).
    CI by a seeded bootstrap over 10-minute blocks (keeps within-block clustering)."""
    t911 = [r.at for r in rows if r.channel == "911"]
    lo, hi = min(t911), max(t911)
    in_win = [r for r in rows if lo <= r.at <= hi and r.channel in ("911", "radio")]
    blocks: dict = defaultdict(lambda: [0, 0])
    for r in in_win:
        blocks[int((r.at - lo).total_seconds() // 600)][0 if r.channel == "radio" else 1] += 1
    n_radio = sum(b[0] for b in blocks.values())
    n_911 = sum(b[1] for b in blocks.values())
    if n_911 == 0:
        return None, None, (lo, hi), n_radio, n_911
    keys = list(blocks)
    rng = random.Random(BOOTSTRAP_SEED)
    ratios = []
    for _ in range(BOOTSTRAP_RESAMPLES):
        s = [blocks[keys[rng.randrange(len(keys))]] for _ in keys]
        d = sum(b[1] for b in s)
        if d:
            ratios.append(sum(b[0] for b in s) / d)
    return n_radio / n_911, (quantile(ratios, 0.025), quantile(ratios, 0.975)), (lo, hi), n_radio, n_911


def rescue_vs_911(rows: list[Row]) -> list[tuple[str, float]]:
    """Per zone: first K-1 rescue row minus first 911 help_needed/trapped row, minutes."""
    first: dict = {}
    for r in sorted(rows, key=lambda r: r.at):
        if not r.zone_id:
            continue
        if r.channel == "911" and r.category in ("help_needed", "trapped"):
            first.setdefault((r.zone_id, "911"), r.at)
        if r.channel == "rescue":
            first.setdefault((r.zone_id, "rescue"), r.at)
    zones = {z for z, _ in first}
    return [(z, (first[(z, "rescue")] - first[(z, "911")]).total_seconds() / 60)
            for z in sorted(zones) if (z, "rescue") in first and (z, "911") in first]


# A K-1 row "coincides" with a 911 row when both fall within these limits. Assumption: the
# record's 1-minute resolution and ~100 m (3-decimal) coordinate rounding.
COINCIDE_MIN = 1.0
COINCIDE_M = 300.0


def rescue_911_coincidence(rows: list[Row], grid: Grid) -> tuple[int, int]:
    """(rescue rows with a coordinate, of which a 911 row lies within COINCIDE_MIN and COINCIDE_M).

    K-1 times are each event's first datapoint, which is often the 911 call itself, so a
    coinciding pair is one source counted twice, not two independent reports."""
    calls = [r for r in rows if r.channel == "911" and r.coord]
    rescues = [r for r in rows if r.channel == "rescue" and r.coord]
    hit = 0
    for r in rescues:
        x0, y0 = grid.to_xy(*r.coord)
        for c in calls:
            if abs((c.at - r.at).total_seconds()) <= COINCIDE_MIN * 60:
                x1, y1 = grid.to_xy(*c.coord)
                if math.hypot(x1 - x0, y1 - y0) <= COINCIDE_M:
                    hit += 1
                    break
    return len(rescues), hit


def distinct_911_calls(rows: list[Row]) -> set[str]:
    """NIST source ids look like '911-014-1' (call 014, observation 1); the call is '911-014'."""
    return {"-".join(r.source_id.split("-")[:2]) for r in rows if r.channel == "911"}


def _iqr_summary(values: list[float]) -> tuple[int, float | None, float | None, float | None]:
    if not values:
        return 0, None, None, None
    return len(values), statistics.median(values), quantile(values, 0.25), quantile(values, 0.75)


@dataclass
class Analysis:
    """All intermediate tables; ``params`` is the frozen summary a generator consumes."""

    zones: list[Zone]
    rows: list[Row]
    t0: datetime
    offsets_observed: list[tuple[Row, float]]
    offsets_modelled: list[tuple[Row, float]]
    fits: dict[str, RateFit]
    units: dict[str, list[dict]]
    empirical: list[tuple]
    road_lags: dict
    ratio: tuple
    rescue_lags: list[tuple[str, float]]
    params: GroundRateParams


def analyse(record: dict, bundle: dict) -> Analysis:
    zones = load_zones(bundle)
    by_id = {z.id: z for z in zones}
    rows = load_rows(record, zones)
    _, _, t0 = arrival_grid(bundle)
    geo_rows = [r for r in rows if r.channel in RATE_CHANNELS]
    off_obs = offsets_min(geo_rows, by_id, "observed")
    off_mod = offsets_min(geo_rows, by_id, "modelled")

    fits, units, empirical = {}, {}, []
    for ch in RATE_CHANNELS:
        fits[ch], units[ch] = fit_channel(rows, zones, ch, t0)
        empirical.extend(empirical_rate_table(units[ch], ch))

    hist = offset_histogram(off_obs, key=lambda r: r.channel)
    mix = [m for ch in RATE_CHANNELS for m in category_mix(rows, by_id, ch)]
    lags = road_report_lags(rows, bundle)
    ratio = radio_911_ratio(rows)
    rescue_lags = rescue_vs_911(rows)

    w0, w1 = (parse_utc(t) for t in PPD_911_WINDOW_UTC)
    calls_in_window = {"-".join(r.source_id.split("-")[:2]) for r in rows if r.channel == "911" and w0 <= r.at < w1}
    params = GroundRateParams(
        model_version=MODEL_VERSION,
        time_zone="UTC (source clock PST, UTC-08:00)",
        arrival_basis="observed: earliest non-residual NIST fire observation in the zone, excluding 911/radio-sourced observations",
        distance_basis="simulated: zone-centroid distance to the nearest burning cell of the bundle's rothermel-mtt arrival grid (200 m cells)",
        order_basis="reconstructed/derived: bundle insights.zones.order_at (first evacuation_order mapped to the block group by crosswalk)",
        offset_summary_observed=tuple(offset_summary(off_obs, ch) for ch in RATE_CHANNELS),
        offset_summary_modelled=tuple(offset_summary(off_mod, ch) for ch in RATE_CHANNELS),
        offset_hist_bin_min=OFFSET_BIN_MIN,
        offset_hist_observed=tuple((ch, tuple(sorted(hist[ch].items()))) for ch in RATE_CHANNELS),
        rate_fits=tuple(fits[ch] for ch in RATE_CHANNELS),
        empirical_rates=tuple(empirical),
        category_mix=tuple(mix),
        road_report_lag_vs_model_min=_iqr_summary([d for _, d in lags["lags_vs_model"]]),
        radio_to_911_ratio=ratio[0],
        radio_to_911_ratio_ci95=ratio[1],
        radio_to_911_window_utc=(format_utc(ratio[2][0]), format_utc(ratio[2][1])),
        rescue_minus_first_911_by_zone_min=_iqr_summary([d for _, d in rescue_lags]),
        rescue_rows_coinciding_with_911=rescue_911_coincidence(rows, arrival_grid(bundle)[0]),
        record_911_rows=sum(1 for r in rows if r.channel == "911"),
        record_911_distinct_calls=len(distinct_911_calls(rows)),
        record_911_calls_in_ppd_window=len(calls_in_window),
        ppd_911_calls_at_least=PPD_911_CALLS_AT_LEAST,
        scale_911_at_least=PPD_911_CALLS_AT_LEAST / len(calls_in_window) if calls_in_window else None,
        scale_911_source=PPD_911_SOURCE,
        notes=(
            "Rates describe one sampled, retrospectively transcribed record; they are not call-centre volumes.",
            "911 coverage is NIST's sample (record rows 15:08-18:06Z); outside that window 911 volume is not estimable.",
            "Radio scaling to true radio volume is not estimable: the radio log's completeness is not stated.",
            "K-1 times are first datapoints; dates after the 23:30 PST row are inferred as 11/9 by the record builder.",
        ),
        rescue_rows_coinciding_with_911_in_window=rescue_911_coincidence(
            [r for r in rows if r.channel != "rescue" or ratio[2][0] <= r.at <= ratio[2][1]], arrival_grid(bundle)[0]),
    )
    return Analysis(zones, rows, t0, off_obs, off_mod, fits, units, empirical, lags, ratio, rescue_lags, params)


def fit_camp_2018(record_path: Path | str = RECORD_PATH, bundle_path: Path | str = BUNDLE_PATH) -> GroundRateParams:
    """Fit the ground-rate parameters on the 2018 Camp Fire record and replay bundle."""
    return analyse(load_json(record_path), load_json(bundle_path)).params
