"""The seams between the agent and everything it does not own.

Each port is a ``Protocol``: the agent's tool layer depends only on these, so a
detection feed, a spread model, or an exposure model can be swapped without the
tools changing. Adapters live in ``crisistwin_agent.detection`` and
``crisistwin_agent.simulation``.

Failure is explicit. A port raises :class:`PortUnavailableError` when it cannot
answer; nothing in this package substitutes a plausible number for a missing
one, and the tool layer turns the exception into an error tool result the model
must account for rather than an empty success.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from .domain import (
    AreaOfInterest,
    DetectionCluster,
    EvacuationAdvisory,
    ExposureAssessment,
    FireDetection,
    SpreadProjection,
    WeatherAssumption,
)


class AgentError(Exception):
    """Base class for every error this package raises deliberately."""


class PortUnavailableError(AgentError):
    """A dependency could not answer: network failure, missing key, no coverage.

    Carries the source so the model can tell the planner precisely what is
    missing instead of reporting a quiet zero.
    """

    def __init__(self, source: str, reason: str) -> None:
        super().__init__(f"{source} unavailable: {reason}")
        self.source = source
        self.reason = reason


class OutOfCoverageError(PortUnavailableError):
    """The request is outside the data or model's valid domain (e.g. LANDFIRE is CONUS-only)."""


class NonBurnableIgnitionError(AgentError):
    """The ignition point carries no fuel, so there is no fire to model there."""


class ApprovalRequiredError(AgentError):
    """Delivery was attempted on an advisory no human has approved."""

    def __init__(self, advisory_id: str, status: str) -> None:
        super().__init__(
            f"advisory {advisory_id} is {status}; delivery requires approval by a named "
            "human planner and an authorised channel"
        )
        self.advisory_id = advisory_id
        self.status = status


@runtime_checkable
class DetectionSource(Protocol):
    """A feed of satellite fire detections over a geographic area."""

    source_id: str

    def fetch(self, area: AreaOfInterest, since: datetime) -> list[FireDetection]:
        """Detections inside ``area`` observed at or after ``since`` (UTC).

        Returns an empty list when the source answered and had nothing - a real
        and useful result. Raises :class:`PortUnavailableError` when it could
        not answer at all. The two must never be conflated.
        """
        ...


@runtime_checkable
class FireSpreadModel(Protocol):
    """Projects how a fire spreads from an ignition point over a horizon."""

    model_id: str

    def project(
        self,
        ignition: DetectionCluster,
        weather: WeatherAssumption,
        horizon_minutes: int,
    ) -> SpreadProjection:
        """Run the spread model.

        Raises :class:`NonBurnableIgnitionError` when the ignition cell carries
        no fuel, :class:`OutOfCoverageError` outside the model's valid domain,
        and :class:`PortUnavailableError` when the model could not be reached.
        """
        ...


@runtime_checkable
class ExposureModel(Protocol):
    """Decides which modelled assets a projected footprint reaches, and when."""

    model_id: str

    def assess(self, projection: SpreadProjection) -> ExposureAssessment:
        """Intersect the projection's frames with the asset registry."""
        ...


@runtime_checkable
class AdvisoryChannel(Protocol):
    """Somewhere an approved advisory can be delivered.

    Every implementation must refuse an advisory that is not approved, by
    raising :class:`ApprovalRequiredError`. V1 ships only a channel that writes
    to the planner's review queue; no channel reaches residents.
    """

    channel_id: str
    reaches_residents: bool

    def deliver(self, advisory: EvacuationAdvisory) -> str:
        """Deliver an approved advisory and return a receipt identifier."""
        ...
