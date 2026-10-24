"""Seeded synthetic 911 calls, radio traffic and rescue requests for a simulated fire scenario.

The comms generator of the scenario engine (docs/adr/0030-scenario-engine.md,
docs/adr/0035-comms-generator.md). It turns a scenario (zones with households, fire arrival
and evacuation orders, a road network, a time window) and the 2018 Camp calibration
(``sim.ground_rates.GroundRateParams``) into items in the ground-record item schema of
``tools/camp_ground_record.json``, each labelled ``evidence_class: "simulated"``.

Standard library only, pure: no I/O except the optional ``write_items_json``. All randomness
comes from ``random.Random`` instances seeded from ``seed`` (string seeds are hashed with
SHA-512 by CPython, so streams do not depend on PYTHONHASHSEED).

Conventions (as in sim/ground_rates.py and docs/ground-data-calibration.md):

- Time: aware UTC ``datetime``; output ``at`` is ISO UTC floored to the minute (the record's
  resolution). Rates are events per 1,000 households per hour (``*_per_khh_h``).
- Distance: metres (``*_m``), local equirectangular projection around each point.
- Coordinates: GeoJSON order (longitude, latitude), EPSG:4326.

Model (each step names its source; choices that are not directly calibrated are the
``ASSUMED_*`` constants below):

1. Per zone and channel, a non-homogeneous Poisson process with rate
   ``exp(intercept + band + phase)`` from the channel's Poisson GLM in ``params.rate_fits``
   (docs/ground-data-calibration.md section 2), times households / 1000, times ``scale_911``
   for the 911 channel, times a gamma zone factor. Sampled exactly by thinning
   (Lewis & Shedler 1979, Naval Research Logistics Quarterly 26(3):403-413).
2. The zone factor has mean 1 and a shape from the fit's Pearson dispersion (gamma-Poisson,
   NB2 variance ``mu + mu^2 / k``; moment estimator ``k = mean(mu) / (dispersion - 1)``,
   Cameron & Trivedi 2013, Regression Analysis of Count Data, 2nd ed., sec. 3.2-3.3).
   Channels share one zone factor (the least variable one), and each other channel multiplies
   it by an independent gamma so its marginal variance matches its own fit.
3. The category is drawn from ``params.category_mix`` for the channel, using the before- or
   after-arrival mix by the zone's fire arrival.
4. Rescue entries are conditioned on the 911 stream: a share equal to the record's
   coinciding share in the 911 coverage window
   (``params.rescue_rows_coinciding_with_911_in_window``, 39/90) takes the time and point of a
   911 call of the same category (help_needed or trapped) in the same zone.
5. Points: road categories (road_blocked, heavy_traffic) are snapped to the nearest named
   road; other categories are a uniform random point inside the zone. Rounded to 3 decimals.
6. ``psap_reroute_at``: 911 calls at or after that time are routed elsewhere and dropped
   from the local stream (Paradise -> Chico at 08:20 PST, 16:20Z, per the calibration source).
7. Bursts (``CommsOptions.bursts``, radio and rescue only): within a zone, rows come in clusters
   in time. Cluster centres follow step 1's process at rate / ``m``; each cluster has a shifted
   geometric number of rows with mean ``m``, each placed uniformly within +-W/2 minutes of the
   centre (a Neyman-Scott cluster process; Neyman & Scott 1958, J. R. Stat. Soc. B 20(1):1-43).
   The expected count is unchanged. Step 2's gamma then takes only the between-zone part of the
   dispersion. Constants and their derivation: ``CALIBRATED_BURST_*`` below.

Nothing here is a forecast or an observed call; every item is a planning-experiment input.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import random
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sim.geo import EARTH_RADIUS_M, point_in_geometry
from sim.ground_rates import (
    DISTANCE_BAND_EDGES_M,
    GLM_DISTANCE_BANDS,
    ORDER_PHASE_EDGES_H,
    ORDER_PHASES,
    RATE_CHANNELS,
    GroundRateParams,
    RateFit,
)
from tools.camp_ground_record import COORD_DECIMALS, summary_for

MODEL_VERSION = "gen-comms-1"
GENERATOR = f"sim/gen_comms.py ({MODEL_VERSION})"
EVIDENCE_CLASS = "simulated"
TIME_PRECISION = "minute"  # record rows are at 1-minute resolution (record header time_conversion)

# Categories whose item carries a road: the record's road categories, which the live review
# queue snaps to a road segment (app/backend/api/live/groundrecord.py, materialize_due).
ROAD_CATEGORIES = frozenset({"road_blocked", "heavy_traffic"})
# 911 categories a rescue entry may bind to (as in ground_rates.rescue_vs_911).
RESCUE_BIND_CATEGORIES = frozenset({"help_needed", "trapped"})
# Channel order for stable sorting of items that share a timestamp.
CHANNEL_ORDER = {ch: i for i, ch in enumerate(RATE_CHANNELS)}

# --- Assumptions (not directly calibrated) ------------------------------------------------

ASSUMED_LT5KM_LEAD_MIN = 33.0
"""When a zone has a fire arrival but no fire-distance function, the ``lt_5km`` band is taken
to hold for this many minutes before arrival. Basis: on Camp, the modelled (rothermel-mtt)
front took a median 33 min (IQR 23-66, n 28 zones) from first coming within 5 km of a zone
centroid to reaching the zone (measured with ``ground_rates.load_zones`` on camp-2018.json,
2026-10-24). It transfers Camp's very fast front to any scenario."""

ASSUMED_RATES_TIME_HOMOGENEOUS = True
"""Rates depend only on distance band and order phase, not on clock time or time of day.
Each GLM was fitted in its channel's coverage window (911: 15-19Z only), so any other hour is
an extrapolation."""

ASSUMED_SCALE_911_ALL_TIMES = True
"""``scale_911`` (calibrated only for 14:30-16:20Z, as a lower bound) multiplies the 911 rate
at every time. The calibration calls 911 volume after 16:20Z not estimable; this is the only
number available."""

ASSUMED_ZONE_FACTOR_SHARED = True
"""One gamma zone factor is shared by all channels (one burnover or one block drives 911,
radio and rescue together); each channel's extra variance is an independent gamma. The
cross-channel correlation of zone residuals was not measured on the record."""

ASSUMED_ZONE_FACTOR_TRANSFERS = True
"""The zone factor's shape, estimated on Camp's block-group zones (median 414 households) and
one-hour units, is used as is for zones of any size."""

ASSUMED_OTHER_CATEGORY_POOLED = True
"""The calibration pools other, evacuation_order, evacuation_progress and shelter into
"other"; generated items keep the pooled "other" rather than inventing a split."""

ASSUMED_RESCUE_BIND_MAX_MIN = 60.0
"""A rescue entry binds to a 911 call of its category in its zone only if one lies within
this many minutes of its drawn time. Basis: per zone, the first K-1 row minus the first 911
help/trapped row ranges -54 to +67 min on Camp (docs section 4); 60 is a round number."""

ASSUMED_RESCUE_BIND_ONE_TO_ONE = True
"""Each 911 call is the first datapoint of at most one rescue entry, of the same category
(help_needed or trapped; the record's K-1 categories)."""

ASSUMED_REROUTE_KEEPS_RESCUE = True
"""A rerouted 911 call still happened: rescue entries may bind to it, and the rescue log keeps
them. Only the local 911 stream loses the call."""

ASSUMED_ROAD_SNAP_MAX_M = 2_000.0
"""A road-category item snaps to the nearest named road edge within this distance of its draw
(about a block group's radius); with none in reach it keeps the interior point and no name."""

ASSUMED_POINT_TRIES = 1_000
"""Rejection-sampling tries for a point inside a zone before falling back to the centroid."""


# --- Bursts (within-zone clustering in time) ----------------------------------------------------
#
# Derivation on tools/camp_ground_record.json and camp-2018.json (43 zones), each channel in its
# GLM coverage window, rows assigned to zones as in ground_rates.load_rows (measured 2026-10-24):
#
# a) Within-zone dispersion. A Poisson GLM with a dummy per zone (zones with >= 1 row) plus the
#    band and phase terms of section 2, on the same zone-hour units, has Pearson chi2/(n-p):
#      911 1.14 (108 units, 31 terms), radio 2.00 (720, 40), rescue 1.46 (918, 38).
#    Zone dummies absorb any constant zone factor, so this is clustering over hours inside a
#    zone. The generator without bursts gives, over 30 seeds at scale 1, median (range):
#      911 0.95 (0.57-2.19), radio 0.98 (0.84-1.34), rescue 1.00 (0.69-1.23).
#    Radio and rescue lie above that range; 911 lies inside it, so 911 gets no bursts.
# b) Excess pairs. Same-zone row pairs with |dt| <= tau, minus the pairs a Poisson process at the
#    zone-dummy GLM's rate (constant in each zone-hour cell) would give. At tau = 0, 10, 20, 30,
#    45, 59 min: radio 16, 124, 212, 276, 357, 408; rescue 11, 51, 94, 120, 157, 171 (911: 36 at
#    59 min). Half of the 59-min excess is reached at tau50 = 19.3 min (radio), 18.1 (rescue).
# c) Cluster model. Rows of one cluster sit at centre + U(-W/2, W/2), so the lag between two of
#    them is triangular on [0, W] with median W (1 - 1/sqrt 2): W = tau50 / 0.293. A shifted
#    geometric size S with mean m has E[S(S-1)]/2 = m (m - 1) pairs per cluster and N/m
#    clusters, so N (m - 1) excess pairs: m = 1 + excess(59) / (N * P(lag <= 59.5 min)).
#      radio:  W = 19.26 / 0.2929 = 65.8 min; m = 1 + 407.8 / (244 * 0.991) = 2.69
#      rescue: W = 18.07 / 0.2929 = 61.7 min; m = 1 + 171.2 / (185 * 0.999) = 1.93
#    Excess (b) is truncated at 59 min (the cell-rate expectation does not reach further), so W
#    is if anything low. The clustering in the record is on the scale of an hour, plus a
#    same-minute spike (radio 16 excess pairs at lag 0), not only a few minutes.

CALIBRATED_BURST_MEAN_ROWS = {"radio": 2.69, "rescue": 1.93}
"""Mean rows per cluster ``m`` (shifted geometric, >= 1), from the record's excess within-zone
pairs (derivation above, step c). Channels not listed have no bursts (911: no evidence, step a)."""

CALIBRATED_BURST_WINDOW_MIN = {"radio": 65.8, "rescue": 61.7}
"""Cluster width W in minutes: rows sit uniformly within +-W/2 of the cluster centre. From the
median lag of the record's excess within-zone pairs (derivation above, step c)."""

CALIBRATED_WITHIN_ZONE_DISPERSION = {"radio": 2.00, "rescue": 1.46}
"""Pearson dispersion of the zone-dummy GLM on the record (derivation above, step a): the part of
the channel's dispersion that is within zones over hours. With bursts on, the gamma zone factor
takes the rest, ``k = mean(mu) / (dispersion - this)``, so the calibrated total is kept."""

ASSUMED_BURST_SIZE_GEOMETRIC = True
"""Cluster size is 1 + geometric (each row is followed by another with probability 1 - 1/m).
The record has too few clusters to choose a size distribution; geometric is the simplest
one-parameter law on {1, 2, ...}."""

ASSUMED_BURST_ROWS_INDEPENDENT = True
"""Rows of one cluster draw their category and point independently (the mix and the uniform
point of steps 3 and 5). Whether a cluster's rows share a category or place was not measured."""


# --- Inputs ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class CommsZone:
    """One scenario zone. Times are aware UTC; ``None`` means never (in the window or at all).

    ``fire_distance_m(at)`` is optional: metres from the zone to the nearest burning point at
    ``at`` (``None`` while nothing burns), 0 once fire is in the zone. It sets the ``lt_5km``
    band; without it ``ASSUMED_LT5KM_LEAD_MIN`` is used. If ``fire_arrival_at`` is ``None`` and
    a distance function is given, arrival is the first minute it returns <= 0.
    """

    id: str
    households: int
    centroid_lonlat: tuple[float, float]
    geometry: dict  # GeoJSON Polygon or MultiPolygon, (lon, lat)
    fire_arrival_at: datetime | None = None
    order_at: datetime | None = None
    fire_distance_m: Callable[[datetime], float | None] | None = None


@dataclass(frozen=True)
class RoadEdge:
    """A road edge as in the replay bundle's ``roads.edges`` (``id``, ``name``, ``coords``)."""

    id: str
    name: str | None
    coords: tuple[tuple[float, float], ...]  # (lon, lat)


@dataclass(frozen=True)
class CommsOptions:
    """``scale_911``: multiplier on 911 rates; ``None`` uses ``params.scale_911_at_least``
    (3.67 on Camp, a lower bound on the true-volume-to-NIST-sample ratio). ``nist_sample_like``
    forces 1.0, so 911 volume looks like the NIST sample the rates were fitted on.
    ``psap_reroute_at``: 911 calls at or after it are dropped from the local stream.
    ``overdispersion=False`` sets every zone factor to 1 (plain Poisson; for tests).
    ``bursts=True`` clusters radio and rescue rows in time within a zone (model step 7);
    ``False`` reproduces the earlier generator (gen-comms-1 without bursts) bit for bit."""

    scale_911: float | None = None
    nist_sample_like: bool = False
    psap_reroute_at: datetime | None = None
    overdispersion: bool = True
    channels: tuple[str, ...] = RATE_CHANNELS
    bursts: bool = True

    def resolved_scale_911(self, params: GroundRateParams) -> float:
        if self.nist_sample_like:
            return 1.0
        if self.scale_911 is not None:
            return self.scale_911
        if params.scale_911_at_least is None:
            raise ValueError("params carry no scale_911_at_least; pass scale_911 or nist_sample_like")
        return params.scale_911_at_least


# --- Calibration accessors --------------------------------------------------------------------

def _fit(params: GroundRateParams, channel: str) -> RateFit:
    for fit in params.rate_fits:
        if fit.channel == channel:
            return fit
    raise KeyError(f"no rate fit for channel {channel!r}")


def _coef(fit: RateFit, term: str) -> float:
    """GLM coefficient; a missing or non-estimable term falls back to the reference level (0)."""
    if term not in fit.terms:
        return 0.0
    j = fit.terms.index(term)
    value = fit.coef[j]
    return value if fit.estimable[j] and math.isfinite(value) else 0.0


def rate_per_khh_h(params: GroundRateParams, channel: str, band: str, phase: str) -> float:
    """GLM rate, events per 1,000 households per hour (docs/ground-data-calibration.md sec. 2):
    exp(intercept + band + phase), reference levels ge_5km_or_unreached and before_order."""
    fit = _fit(params, channel)
    eta = fit.coef[fit.terms.index("intercept")]
    if band != GLM_DISTANCE_BANDS[-1]:
        eta += _coef(fit, f"band:{band}")
    if phase != ORDER_PHASES[0]:
        eta += _coef(fit, f"phase:{phase}")
    return math.exp(eta)


def gamma_shape(fit: RateFit, within_dispersion: float = 1.0) -> float:
    """Gamma frailty shape k from the Pearson dispersion: E[X^2/(n-p)] ~ phi + mean(mu)/k for a
    gamma-mixed process whose within-zone variance is phi * mu (phi = 1 for Poisson, NB2), and
    mean(mu) = n_events / n_units for a Poisson GLM with an intercept. ``inf`` = no frailty."""
    if (not math.isfinite(fit.dispersion) or fit.dispersion <= within_dispersion
            or fit.n_units == 0):
        return math.inf
    return (fit.n_events / fit.n_units) / (fit.dispersion - within_dispersion)


def burst_channels(options: CommsOptions) -> dict[str, tuple[float, float]]:
    """{channel: (mean rows per cluster, window_min)} for the channels that burst, or {}."""
    if not options.bursts:
        return {}
    return {ch: (CALIBRATED_BURST_MEAN_ROWS[ch], CALIBRATED_BURST_WINDOW_MIN[ch])
            for ch in options.channels if ch in CALIBRATED_BURST_MEAN_ROWS}


def zone_factor_shapes(params: GroundRateParams, channels: Sequence[str],
                       within_dispersion: Mapping[str, float] | None = None) -> tuple[float, dict[str, float]]:
    """(shared shape, extra shape per channel). The shared factor takes the largest shape (least
    variance); a channel with shape k gets an extra gamma of shape h so that the product of two
    independent mean-1 gammas has variance 1/k: (1 + 1/k_s)(1 + 1/h) - 1 = 1/k.
    ``within_dispersion``: per channel, the within-zone part of the dispersion carried by bursts
    (default 1, Poisson)."""
    within = within_dispersion or {}
    shapes = {ch: gamma_shape(_fit(params, ch), within.get(ch, 1.0)) for ch in channels}
    shared = max(shapes.values())
    extra = {}
    for ch, k in shapes.items():
        inv_h = (1 + 1 / k) / (1 + 1 / shared) - 1 if math.isfinite(k) else 0.0
        extra[ch] = 1 / inv_h if inv_h > 1e-12 else math.inf
    return shared, extra


def _mix(params: GroundRateParams, channel: str, phase: str) -> list[tuple[str, float]]:
    """Category shares for the channel and phase (before_arrival / after_arrival). A phase with
    no rows falls back to the other phase."""
    by_phase = {p: (shares, n) for ch, p, shares, n in params.category_mix if ch == channel}
    shares, n = by_phase.get(phase, ((), 0))
    if not n:
        other = "after_arrival" if phase == "before_arrival" else "before_arrival"
        shares, n = by_phase.get(other, ((), 0))
    clean = [(c, s) for c, s in shares if isinstance(s, (int, float)) and math.isfinite(s) and s > 0]
    if not clean:
        raise ValueError(f"no category mix for channel {channel!r}")
    return clean


def rescue_bind_share(params: GroundRateParams) -> float:
    """Share of rescue rows that coincide with a 911 row (within 1 min and 300 m), counted over
    rescue rows inside the 911 sample's coverage window, where a partner call can exist: 39/90
    on Camp. Over all rescue rows it is 39/190; that denominator includes rows with no 911
    coverage at all, so it understates the share. A lower bound either way: 911 is a sample."""
    total, hit = params.rescue_rows_coinciding_with_911_in_window
    if not total:  # params from before the in-window field existed
        total, hit = params.rescue_rows_coinciding_with_911
    return hit / total if total else 0.0


def params_hash(params: GroundRateParams, options: CommsOptions) -> str:
    """12-hex SHA-256 of the canonical JSON of (generator version, params, options)."""
    opts = asdict(options)
    opts["psap_reroute_at"] = _iso(options.psap_reroute_at) if options.psap_reroute_at else None
    # Without bursts the hash is the earlier generator's (bit-identical output); with bursts it
    # also covers the burst constants.
    del opts["bursts"]
    if options.bursts:
        opts["bursts"] = {ch: [m, w, CALIBRATED_WITHIN_ZONE_DISPERSION[ch]]
                          for ch, (m, w) in sorted(burst_channels(options).items())}
    blob = json.dumps({"generator": MODEL_VERSION, "params": params.to_dict(), "options": opts},
                      sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def params_from_dict(data: Mapping) -> GroundRateParams:
    """Rebuild ``GroundRateParams`` from ``to_dict()`` output (for example a stored JSON file)."""
    def tup(value):
        return tuple(tup(v) for v in value) if isinstance(value, list) else value

    kwargs = {}
    for f in fields(GroundRateParams):
        if f.name not in data:
            continue
        value = data[f.name]
        if f.name == "rate_fits":
            value = tuple(RateFit(**{k: tup(v) for k, v in fit.items()}) for fit in value)
        else:
            value = tup(value)
        kwargs[f.name] = value
    return GroundRateParams(**kwargs)


# --- Covariates -------------------------------------------------------------------------------

def _iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _arrival(zone: CommsZone, window: tuple[datetime, datetime]) -> datetime | None:
    if zone.fire_arrival_at is not None or zone.fire_distance_m is None:
        return zone.fire_arrival_at
    t, end = window
    while t < end:  # first minute the distance function reports fire in the zone
        d = zone.fire_distance_m(t)
        if d is not None and d <= 0.0:
            return t
        t += timedelta(minutes=1)
    return None


def distance_band(zone: CommsZone, arrival: datetime | None, at: datetime) -> str:
    """GLM band (ground_rates.GLM_DISTANCE_BANDS) at ``at``: fire_in_zone once arrival has passed,
    lt_5km within DISTANCE_BAND_EDGES_M[1] of the front, else ge_5km_or_unreached."""
    if arrival is not None and at >= arrival:
        return GLM_DISTANCE_BANDS[0]
    if zone.fire_distance_m is not None:
        d = zone.fire_distance_m(at)
        near = d is not None and d < DISTANCE_BAND_EDGES_M[1]
    else:
        near = arrival is not None and (arrival - at) <= timedelta(minutes=ASSUMED_LT5KM_LEAD_MIN)
    return GLM_DISTANCE_BANDS[1] if near else GLM_DISTANCE_BANDS[2]


def order_phase(zone: CommsZone, at: datetime) -> str:
    """Order phase as in ground_rates.order_phase (edges ORDER_PHASE_EDGES_H)."""
    if zone.order_at is None or at < zone.order_at:
        return ORDER_PHASES[0]
    hours = (at - zone.order_at).total_seconds() / 3600
    return ORDER_PHASES[1] if hours < ORDER_PHASE_EDGES_H[1] else ORDER_PHASES[2]


def zone_rate_per_h(params: GroundRateParams, zone: CommsZone, arrival: datetime | None, channel: str,
                    at: datetime, scale: float = 1.0) -> float:
    """Expected events per hour in the zone at ``at`` before the zone factor (mean 1)."""
    rate = rate_per_khh_h(params, channel, distance_band(zone, arrival, at), order_phase(zone, at))
    return rate * zone.households / 1000.0 * scale


# --- Geometry -------------------------------------------------------------------------------

def _m_per_deg(lat: float) -> tuple[float, float]:
    m_lat = math.radians(1) * EARTH_RADIUS_M
    return m_lat * math.cos(math.radians(lat)), m_lat


def _bbox(geometry: dict) -> tuple[float, float, float, float]:
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    xs = [pt[0] for poly in polys for ring in poly for pt in ring]
    ys = [pt[1] for poly in polys for ring in poly for pt in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _round(lon: float, lat: float) -> list[float]:
    return [round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)]


def interior_point(rng: random.Random, zone: CommsZone, bbox: tuple[float, float, float, float]) -> list[float]:
    """Uniform point in the zone by rejection in its bbox, rounded to the record's 3 decimals
    and kept only if the rounded point is still inside (so the zone is recoverable from it)."""
    x0, y0, x1, y1 = bbox
    for _ in range(ASSUMED_POINT_TRIES):
        pt = _round(rng.uniform(x0, x1), rng.uniform(y0, y1))
        if point_in_geometry(pt[0], pt[1], zone.geometry):
            return pt
    return _round(*zone.centroid_lonlat)


def _snap(lon: float, lat: float, edges: Iterable[RoadEdge]) -> tuple[float, float, str, float] | None:
    """Nearest point on a named edge: (lon, lat, name, distance_m), in a local projection at lat."""
    mx, my = _m_per_deg(lat)
    best = None
    for edge in edges:
        if not edge.name:
            continue
        pts = [((x - lon) * mx, (y - lat) * my) for x, y in edge.coords]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
            px, py = ax + t * dx, ay + t * dy
            d = math.hypot(px, py)
            if best is None or d < best[3]:
                best = (lon + px / mx, lat + py / my, edge.name, d)
    return best


class _RoadIndex:
    """Named edges near each zone (bbox + ASSUMED_ROAD_SNAP_MAX_M), computed lazily."""

    def __init__(self, roads: Sequence[RoadEdge]):
        self.roads = [r for r in roads if r.name and len(r.coords) >= 2]
        self.boxes = [(min(p[0] for p in r.coords), min(p[1] for p in r.coords),
                       max(p[0] for p in r.coords), max(p[1] for p in r.coords)) for r in self.roads]
        self.cache: dict[str, list[RoadEdge]] = {}

    def near(self, zone_id: str, bbox: tuple[float, float, float, float]) -> list[RoadEdge]:
        if zone_id not in self.cache:
            mx, my = _m_per_deg((bbox[1] + bbox[3]) / 2)
            ex, ey = ASSUMED_ROAD_SNAP_MAX_M / mx, ASSUMED_ROAD_SNAP_MAX_M / my
            x0, y0, x1, y1 = bbox[0] - ex, bbox[1] - ey, bbox[2] + ex, bbox[3] + ey
            self.cache[zone_id] = [r for r, b in zip(self.roads, self.boxes)
                                   if b[0] <= x1 and b[2] >= x0 and b[1] <= y1 and b[3] >= y0]
        return self.cache[zone_id]


# --- Process --------------------------------------------------------------------------------

def _thinned_times(rng: random.Random, rate_fn: Callable[[datetime], float], rate_max_per_h: float,
                   start: datetime, end: datetime) -> list[datetime]:
    """Event times of a non-homogeneous Poisson process with rate_fn(t) <= rate_max_per_h on
    [start, end), by thinning (Lewis & Shedler 1979)."""
    out: list[datetime] = []
    if rate_max_per_h <= 0:
        return out
    span_h = (end - start).total_seconds() / 3600
    t_h = 0.0
    while True:
        t_h += rng.expovariate(rate_max_per_h)
        if t_h >= span_h:
            return out
        at = start + timedelta(hours=t_h)
        if at >= end:  # guard against float rounding at the boundary
            return out
        if rng.random() * rate_max_per_h < rate_fn(at):
            out.append(at)


def _burst_times(rng: random.Random, brng: random.Random, rate_fn: Callable[[datetime], float],
                 rate_max_per_h: float, start: datetime, end: datetime, mean_rows: float,
                 window_min: float) -> list[datetime]:
    """Neyman-Scott cluster process on [start, end) with the same expected count as the Poisson
    process of ``rate_fn``: centres at rate_fn / mean_rows by thinning (``rng``), drawn on the
    window widened by W/2 each side so clusters straddling an edge are kept in part; each centre
    has 1 + Geometric(1 - 1/mean_rows) rows at centre + U(-W/2, W/2) (``brng``)."""
    half = timedelta(minutes=window_min / 2)
    centres = _thinned_times(rng, lambda t: rate_fn(t) / mean_rows, rate_max_per_h / mean_rows,
                             start - half, end + half)
    p_more = 1.0 - 1.0 / mean_rows
    out = []
    for c in centres:
        size = 1
        while brng.random() < p_more:
            size += 1
        for _ in range(size):
            at = c + timedelta(minutes=brng.uniform(-window_min / 2, window_min / 2))
            if start <= at < end:
                out.append(at)
    out.sort()
    return out


def _draw_category(rng: random.Random, mix: list[tuple[str, float]]) -> str:
    total = sum(s for _, s in mix)
    u = rng.random() * total
    acc = 0.0
    for category, share in mix:
        acc += share
        if u < acc:
            return category
    return mix[-1][0]


@dataclass
class _Event:
    at: datetime
    channel: str
    zone_id: str
    category: str
    coord: list[float]
    road_name: str | None
    seq: int


def _validate(zones: Sequence[CommsZone], window: tuple[datetime, datetime], options: CommsOptions) -> None:
    start, end = window
    for t in (start, end, options.psap_reroute_at):
        if t is not None and t.tzinfo is None:
            raise ValueError("times must be timezone-aware (UTC)")
    if not start < end:
        raise ValueError("window start must be before its end")
    if start.second or start.microsecond:
        raise ValueError("window start must be minute-aligned (items are floored to the minute)")
    for ch in options.channels:
        if ch not in RATE_CHANNELS:
            raise ValueError(f"unknown channel {ch!r}")
    ids = [z.id for z in zones]
    if len(set(ids)) != len(ids):
        raise ValueError("zone ids must be unique")
    for z in zones:
        if z.households < 0:
            raise ValueError(f"zone {z.id}: households must be non-negative")


def generate_comms(
    zones: Sequence[CommsZone],
    roads: Sequence[RoadEdge],
    window_utc: tuple[datetime, datetime],
    params: GroundRateParams,
    seed: int,
    options: CommsOptions = CommsOptions(),
) -> list[dict]:
    """Synthetic 911, radio and rescue items for the scenario, time-ordered, in the ground-record
    item schema plus ``generator``, ``params_hash`` and ``seed``. Deterministic in ``seed``."""
    _validate(zones, window_utc, options)
    start, end = window_utc
    scale_911 = options.resolved_scale_911(params)
    if scale_911 < 0:
        raise ValueError("scale_911 must be non-negative")
    channels = tuple(ch for ch in RATE_CHANNELS if ch in options.channels)
    bursts = burst_channels(options)
    shared_k, extra_k = zone_factor_shapes(
        params, channels, {ch: CALIBRATED_WITHIN_ZONE_DISPERSION[ch] for ch in bursts})
    bind_share = rescue_bind_share(params)
    road_index = _RoadIndex(roads)
    phash = params_hash(params, options)

    events: list[_Event] = []
    for zone in sorted(zones, key=lambda z: z.id):
        if zone.households == 0:
            continue
        arrival = _arrival(zone, window_utc)
        bbox = _bbox(zone.geometry)
        # Zone factors: one shared draw, then one extra draw per channel (fixed order).
        frng = random.Random(f"{seed}:{zone.id}:factor")
        shared = frng.gammavariate(shared_k, 1 / shared_k) if options.overdispersion and math.isfinite(shared_k) else 1.0
        factors = {}
        for ch in RATE_CHANNELS:
            k = extra_k.get(ch, math.inf)
            extra = frng.gammavariate(k, 1 / k) if options.overdispersion and math.isfinite(k) else 1.0
            factors[ch] = shared * extra
        by_channel: dict[str, list[_Event]] = {}
        for ch in channels:
            rng = random.Random(f"{seed}:{zone.id}:{ch}")
            scale = scale_911 if ch == "911" else 1.0
            mult = factors[ch]
            peak = max(rate_per_khh_h(params, ch, b, p) for b in GLM_DISTANCE_BANDS for p in ORDER_PHASES)
            rate_max = peak * zone.households / 1000.0 * scale * mult
            rate_fn = (lambda t, ch=ch, scale=scale, mult=mult:
                       zone_rate_per_h(params, zone, arrival, ch, t, scale) * mult)
            if ch in bursts:
                times = _burst_times(rng, random.Random(f"{seed}:{zone.id}:{ch}:burst"), rate_fn,
                                     rate_max, start, end, *bursts[ch])
            else:
                times = _thinned_times(rng, rate_fn, rate_max, start, end)
            out = []
            for i, at in enumerate(times):
                phase = "after_arrival" if arrival is not None and at >= arrival else "before_arrival"
                category = _draw_category(rng, _mix(params, ch, phase))
                coord = interior_point(rng, zone, bbox)
                road_name = None
                if category in ROAD_CATEGORIES:
                    snapped = _snap(coord[0], coord[1], road_index.near(zone.id, bbox))
                    if snapped is not None and snapped[3] <= ASSUMED_ROAD_SNAP_MAX_M:
                        coord, road_name = _round(snapped[0], snapped[1]), snapped[2]
                out.append(_Event(at, ch, zone.id, category, coord, road_name, i))
            by_channel[ch] = out
        if "rescue" in by_channel and "911" in by_channel:
            _bind_rescue(random.Random(f"{seed}:{zone.id}:bind"), by_channel["rescue"], by_channel["911"], bind_share)
        for out in by_channel.values():
            events.extend(out)

    if options.psap_reroute_at is not None:
        events = [e for e in events if not (e.channel == "911" and e.at >= options.psap_reroute_at)]
    events.sort(key=lambda e: (e.at, CHANNEL_ORDER[e.channel], e.zone_id, e.seq))
    return [_item(e, n, seed, phash) for n, e in enumerate(events)]


def _bind_rescue(rng: random.Random, rescues: list[_Event], calls: list[_Event], share: float) -> None:
    """With probability ``share`` a rescue entry becomes the record of a 911 call in the same zone
    with the same category (help_needed or trapped), the nearest unused one within
    ASSUMED_RESCUE_BIND_MAX_MIN: it takes the call's time and point, as K-1 first datapoints
    often are the 911 call (docs section 4). Matching the category keeps the rescue mix as
    calibrated. One uniform is drawn per rescue entry whether or not it binds."""
    pools: dict[str, list[_Event]] = {}
    for c in sorted(calls, key=lambda c: c.at):
        if c.category in RESCUE_BIND_CATEGORIES:
            pools.setdefault(c.category, []).append(c)
    times = {cat: [c.at for c in pool] for cat, pool in pools.items()}
    used = {cat: [False] * len(pool) for cat, pool in pools.items()}
    limit = timedelta(minutes=ASSUMED_RESCUE_BIND_MAX_MIN)
    for r in rescues:
        if rng.random() >= share or r.category not in pools:
            continue
        pool, taken = pools[r.category], used[r.category]
        i = bisect.bisect_left(times[r.category], r.at)
        before = next((j for j in range(i - 1, -1, -1) if not taken[j]), None)
        after = next((j for j in range(i, len(pool)) if not taken[j]), None)
        best = min((j for j in (before, after) if j is not None), key=lambda j: abs(pool[j].at - r.at), default=None)
        if best is None or abs(pool[best].at - r.at) > limit:
            continue
        taken[best] = True
        r.at, r.coord, r.road_name = pool[best].at, list(pool[best].coord), pool[best].road_name
    rescues.sort(key=lambda e: e.at)


def _item(e: _Event, n: int, seed: int, phash: str) -> dict:
    at = e.at.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return {
        "id": f"gen-comms-{seed}-{n:05d}",
        "at": _iso(at),
        "time_precision": TIME_PRECISION,
        "channel": e.channel,
        "category": e.category,
        "road_name": e.road_name,
        "coord": e.coord,
        "summary": summary_for(e.channel, e.category, e.road_name),
        "evidence_class": EVIDENCE_CLASS,
        "source_locator": f"{GENERATOR}; seed {seed}; params {phash}; zone {e.zone_id}",
        "text_sha12": None,  # no source text exists for a generated item
        "generator": GENERATOR,
        "params_hash": phash,
        "seed": seed,
    }


# --- Adapters and optional output -----------------------------------------------------------

def roads_from_bundle(bundle: Mapping) -> list[RoadEdge]:
    """Road edges from a replay bundle's ``roads.edges`` (or a drill package with that shape)."""
    return [RoadEdge(id=e["id"], name=e.get("name"), coords=tuple(tuple(p[:2]) for p in e["coords"]))
            for e in bundle["roads"]["edges"]]


def zones_from_bundle(bundle: Mapping) -> list[CommsZone]:
    """Camp-style bundle zones: households, modelled arrival, order, and the modelled front
    distance (``ground_rates.load_zones``), as generator input. Fire basis: simulated."""
    from sim.ground_rates import arrival_grid, load_zones

    _, _, t0 = arrival_grid(bundle)
    out = []
    for z in load_zones(bundle):
        def dist(at: datetime, z=z) -> float | None:
            return z.front_distance_m((at - t0).total_seconds() / 60)

        out.append(CommsZone(id=z.id, households=z.households, centroid_lonlat=tuple(z.centroid_lonlat),
                             geometry=z.geometry, fire_arrival_at=z.modelled_arrival_at, order_at=z.order_at,
                             fire_distance_m=dist))
    return out


def write_items_json(path: Path | str, items: Sequence[dict], *, seed: int, params_hash_hex: str) -> None:
    """Write items in the ground-record file layout (``items`` plus a header naming the basis)."""
    doc = {
        "dataset": "Simulated 911, radio and rescue items (not observed data)",
        "generator": GENERATOR,
        "evidence_class": EVIDENCE_CLASS,
        "calibration": "sim/ground_rates.py fit_camp_2018 (NIST TN 2252 sample of the 2018 Camp Fire)",
        "seed": seed,
        "params_hash": params_hash_hex,
        "time_zone": "UTC",
        "coordinate_order": "longitude, latitude",
        "coordinate_crs": "EPSG:4326",
        "coordinate_precision": f"rounded to {COORD_DECIMALS} decimal places",
        "items": list(items),
    }
    Path(path).write_text(json.dumps(doc, indent=1) + "\n")
