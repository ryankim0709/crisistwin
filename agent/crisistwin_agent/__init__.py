"""CrisisTwin fire-watch agent.

Watches an area for satellite fire detections, projects how a detected fire
could spread using the project's Rothermel model, works out which modelled
neighborhoods, shelters and roads that projection reaches, and drafts an
evacuation advisory for a human planner to review.

Claude orchestrates the tools and explains the results. Claude does not compute
them: perimeters, arrival times and exposure counts come from the simulation,
and advisories require human approval before anything can be delivered.
"""

from __future__ import annotations

from .config import AgentConfig, MissingCredentialError
from .domain import (
    AreaOfInterest,
    DetectionCluster,
    EvacuationAdvisory,
    Evidence,
    ExposedAsset,
    ExposureAssessment,
    FireDetection,
    GeoPoint,
    SpreadProjection,
    WeatherAssumption,
)
from .ports import (
    AgentError,
    AdvisoryChannel,
    ApprovalRequiredError,
    DetectionSource,
    ExposureModel,
    FireSpreadModel,
    NonBurnableIgnitionError,
    OutOfCoverageError,
    PortUnavailableError,
)
from .runner import WatchRunResult, run_watch, summarize_run
from .tools import WatchSession, build_tools

__all__ = [
    "AdvisoryChannel",
    "AgentConfig",
    "AgentError",
    "ApprovalRequiredError",
    "AreaOfInterest",
    "DetectionCluster",
    "DetectionSource",
    "EvacuationAdvisory",
    "Evidence",
    "ExposedAsset",
    "ExposureAssessment",
    "ExposureModel",
    "FireDetection",
    "FireSpreadModel",
    "GeoPoint",
    "MissingCredentialError",
    "NonBurnableIgnitionError",
    "OutOfCoverageError",
    "PortUnavailableError",
    "SpreadProjection",
    "WatchRunResult",
    "WatchSession",
    "WeatherAssumption",
    "build_tools",
    "run_watch",
    "summarize_run",
]
