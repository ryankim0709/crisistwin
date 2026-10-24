"""Value objects shared by every part of the fire-watch agent.

Conventions are fixed here and converted once, at adapter boundaries:

- Coordinates are WGS84 decimal degrees; longitude is normalised to [-180, 180).
- Ground distances and areas are metres and square metres.
- Wall-clock times are timezone-aware UTC ``datetime`` objects.
- Elapsed simulation times are whole minutes measured from ignition.

The four kinds of information the project keeps separate (see ``AGENTS.md``) are
modelled explicitly by :class:`Evidence`: an observation is not a simulation, a
recorded fixture is not live data, and a planner assumption is neither. Every
record that reaches the model or the UI carries the provenance that says which
it is, and deriving data never widens a narrower kind.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

EvidenceKind = Literal["observation", "recorded-fixture", "simulation", "assumption"]

AdvisoryStatus = Literal["draft", "pending_approval", "approved", "rejected"]

DetectionConfidence = Literal["low", "nominal", "high"]

EARTH_RADIUS_METERS = 6_371_008.8

_CONFIDENCE_ORDER: dict[DetectionConfidence, int] = {"low": 0, "nominal": 1, "high": 2}


def utc_now() -> datetime:
    """Wall-clock time, used only for provenance stamps - never for model progression."""
    return datetime.now(timezone.utc)


def _require_utc(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{field_name} must be timezone-aware UTC, got a naive datetime")
    return value.astimezone(timezone.utc)


@dataclass(frozen=True, slots=True)
class Evidence:
    """Where one record came from, and what kind of claim it can support."""

    kind: EvidenceKind
    source_id: str
    source_name: str
    retrieved_at: datetime
    source_url: str | None = None
    note: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "retrieved_at", _require_utc(self.retrieved_at, "retrieved_at"))

    @property
    def is_live_observation(self) -> bool:
        return self.kind == "observation"

    def label(self) -> str:
        """Short human-readable tag for UI, report, and advisory surfaces."""
        return {
            "observation": "observed",
            "recorded-fixture": "RECORDED FIXTURE - not live data",
            "simulation": "simulated",
            "assumption": "planner assumption",
        }[self.kind]


@dataclass(frozen=True, slots=True)
class GeoPoint:
    """WGS84 decimal degrees. Longitude is normalised to [-180, 180)."""

    latitude: float
    longitude: float

    def __post_init__(self) -> None:
        if not -90.0 <= self.latitude <= 90.0:
            raise ValueError(f"latitude {self.latitude} outside [-90, 90]")
        if not math.isfinite(self.longitude):
            raise ValueError("longitude must be finite")
        object.__setattr__(self, "longitude", (self.longitude + 180.0) % 360.0 - 180.0)

    def distance_meters(self, other: GeoPoint) -> float:
        """Great-circle ground distance in metres (haversine, spherical earth)."""
        lat1, lat2 = math.radians(self.latitude), math.radians(other.latitude)
        dlat = lat2 - lat1
        dlon = math.radians(other.longitude - self.longitude)
        h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        return 2 * EARTH_RADIUS_METERS * math.asin(min(1.0, math.sqrt(h)))


@dataclass(frozen=True, slots=True)
class AreaOfInterest:
    """The region one watch run covers: a centre and a ground radius."""

    name: str
    center: GeoPoint
    radius_meters: float

    def __post_init__(self) -> None:
        if self.radius_meters <= 0:
            raise ValueError("radius_meters must be positive")
        if self.radius_meters > 100_000:
            raise ValueError("radius_meters above 100 km is outside the intended watch scale")

    def contains(self, point: GeoPoint) -> bool:
        return self.center.distance_meters(point) <= self.radius_meters


@dataclass(frozen=True, slots=True)
class FireDetection:
    """One satellite thermal anomaly.

    A detection is an *observation of heat*, not a fire perimeter and not a road
    closure. ``brightness_kelvin`` is the channel brightness temperature exactly
    as the provider published it; it is not converted or thresholded here.
    """

    detected_at: datetime
    location: GeoPoint
    satellite: str
    instrument: str
    confidence: DetectionConfidence
    brightness_kelvin: float | None
    frp_megawatts: float | None
    evidence: Evidence
    external_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "detected_at", _require_utc(self.detected_at, "detected_at"))


@dataclass(frozen=True, slots=True)
class DetectionCluster:
    """Detections grouped as plausibly one fire.

    The grouping is a heuristic over pixel positions, not a finding about how
    many distinct fires exist. ``grouping_method`` records how it was produced.
    """

    cluster_id: str
    detections: tuple[FireDetection, ...]
    centroid: GeoPoint
    radius_meters: float
    grouping_method: str

    def __post_init__(self) -> None:
        if not self.detections:
            raise ValueError("a cluster needs at least one detection")

    @property
    def earliest_detected_at(self) -> datetime:
        return min(d.detected_at for d in self.detections)

    @property
    def latest_detected_at(self) -> datetime:
        return max(d.detected_at for d in self.detections)

    @property
    def highest_confidence(self) -> DetectionConfidence:
        return max((d.confidence for d in self.detections), key=lambda c: _CONFIDENCE_ORDER[c])

    @property
    def total_frp_megawatts(self) -> float | None:
        known = [d.frp_megawatts for d in self.detections if d.frp_megawatts is not None]
        return sum(known) if known else None


@dataclass(frozen=True, slots=True)
class WeatherAssumption:
    """Wind and fuel moisture a projection runs under.

    ``wind_from_degrees`` is meteorological: the bearing the wind blows *from*,
    clockwise from true north. These are planner assumptions unless the attached
    evidence says ``observation``.
    """

    wind_speed_mph: float
    wind_from_degrees: float
    moisture_preset: str
    evidence: Evidence

    def __post_init__(self) -> None:
        if self.wind_speed_mph < 0:
            raise ValueError("wind_speed_mph must be nonnegative")
        object.__setattr__(self, "wind_from_degrees", self.wind_from_degrees % 360.0)


@dataclass(frozen=True, slots=True)
class SpreadFrame:
    """One simulation step. ``perimeter`` is a GeoJSON FeatureCollection."""

    elapsed_minutes: int
    perimeter: dict[str, Any]
    burned_area_square_meters: float
    max_reach_meters: float

    def __post_init__(self) -> None:
        if self.elapsed_minutes < 0:
            raise ValueError("elapsed_minutes must be nonnegative")
        if self.burned_area_square_meters < 0 or self.max_reach_meters < 0:
            raise ValueError("burned area and reach must be nonnegative")


@dataclass(frozen=True, slots=True)
class SpreadProjection:
    """A fire-spread model run. Every number here is simulated, never observed."""

    run_id: str
    model_id: str
    ignition: GeoPoint
    weather: WeatherAssumption
    step_minutes: int
    horizon_minutes: int
    frames: tuple[SpreadFrame, ...]
    evidence: Evidence
    limitations: tuple[str, ...] = ()
    fuel_label: str | None = None
    head_rate_meters_per_minute: float | None = None
    burnable_fraction: float | None = None
    reached_edge: bool = False

    def __post_init__(self) -> None:
        if self.evidence.kind not in ("simulation", "recorded-fixture"):
            raise ValueError("a SpreadProjection is simulated or replayed, never an observation")
        if not self.frames:
            raise ValueError("a projection needs at least one frame")

    @property
    def final_frame(self) -> SpreadFrame:
        return max(self.frames, key=lambda f: f.elapsed_minutes)

    def frame_at(self, elapsed_minutes: int) -> SpreadFrame | None:
        for frame in self.frames:
            if frame.elapsed_minutes == elapsed_minutes:
                return frame
        return None


AssetKind = Literal["road_segment", "shelter", "neighborhood", "facility"]


@dataclass(frozen=True, slots=True)
class ExposedAsset:
    """Something the projected footprint reaches, and when it reaches it."""

    kind: AssetKind
    asset_id: str
    name: str
    first_exposure_minutes: int | None
    """``None`` means exposed at an unknown time within the horizon - not that it is safe."""

    population_estimate: int | None = None

    def __post_init__(self) -> None:
        if self.population_estimate is not None and self.population_estimate < 0:
            raise ValueError("population_estimate must be nonnegative")


@dataclass(frozen=True, slots=True)
class ExposureAssessment:
    """Which modelled assets a projection reaches. Derived from a projection, so simulated."""

    projection_run_id: str
    assets: tuple[ExposedAsset, ...]
    evidence: Evidence
    limitations: tuple[str, ...] = ()

    @property
    def population_at_risk(self) -> int | None:
        """Sum of known estimates, or ``None`` when no exposed asset carries one."""
        known = [a.population_estimate for a in self.assets if a.population_estimate is not None]
        return sum(known) if known else None

    def earliest_exposure_minutes(self) -> int | None:
        known = [a.first_exposure_minutes for a in self.assets if a.first_exposure_minutes is not None]
        return min(known) if known else None


@dataclass(slots=True)
class EvacuationAdvisory:
    """A drafted evacuation advisory.

    CrisisTwin does not issue resident guidance. An advisory is created as a
    ``draft``; only a named human may move it to ``approved``, and delivery
    channels must refuse anything that is not approved. See ``AGENTS.md``:
    simulated recommendations are not operational instructions.
    """

    area: AreaOfInterest
    headline: str
    body: str
    affected_assets: tuple[ExposedAsset, ...]
    basis: tuple[Evidence, ...]
    model_run_ids: tuple[str, ...]
    limitations: tuple[str, ...]
    advisory_id: str = field(default_factory=lambda: f"adv_{uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=utc_now)
    status: AdvisoryStatus = "draft"
    approved_by: str | None = None
    approved_at: datetime | None = None
    rejection_reason: str | None = None

    def __post_init__(self) -> None:
        if not self.basis:
            raise ValueError("an advisory must cite the evidence it rests on")
        if self.status == "approved" and not self.approved_by:
            raise ValueError("an approved advisory must name its human approver")

    def approve(self, approver: str) -> None:
        """Record human approval. Called by a planner workflow, never by the model."""
        if not approver.strip():
            raise ValueError("approver must be a named person or role")
        if self.status == "rejected":
            raise ValueError("a rejected advisory cannot be approved; draft a new one")
        self.status = "approved"
        self.approved_by = approver.strip()
        self.approved_at = utc_now()

    def reject(self, reason: str) -> None:
        self.status = "rejected"
        self.rejection_reason = reason

    @property
    def is_deliverable(self) -> bool:
        return self.status == "approved" and self.approved_by is not None

    @staticmethod
    def disclosure() -> str:
        """The standing caveat that travels with every advisory surface."""
        return (
            "CrisisTwin output is a planning experiment produced by a simulation model. "
            "It is not operational evacuation guidance and carries no authority approval."
        )
