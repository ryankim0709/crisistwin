"""Detection feeds: what the agent uses to answer "is anything burning here now?".

Two adapters implement :class:`~crisistwin_agent.ports.DetectionSource`:
:class:`FirmsDetectionSource` queries NASA FIRMS live and emits observations,
and :class:`FixtureDetectionSource` replays a JSON file and emits recorded
fixtures, so the demo runs offline without either being mistaken for the other.
:func:`cluster_detections` groups whichever detections came back into plausible
incidents - a heuristic, not a count of fires.
"""

from __future__ import annotations

from .clustering import DEFAULT_LINK_DISTANCE_METERS, cluster_detections
from .firms import (
    DEFAULT_FIRMS_SOURCES,
    FIRMS_MAP_KEY_ENV_VAR,
    MAX_DAY_RANGE_DAYS,
    MODIS_HIGH_CONFIDENCE_PERCENT,
    MODIS_NOMINAL_CONFIDENCE_PERCENT,
    REDACTED_MAP_KEY,
    SUPPORTED_FIRMS_SOURCES,
    FirmsDetectionSource,
)
from .fixtures import BERKELEY_FIXTURE_PATH, FixtureDetectionSource

__all__ = [
    "BERKELEY_FIXTURE_PATH",
    "DEFAULT_FIRMS_SOURCES",
    "DEFAULT_LINK_DISTANCE_METERS",
    "FIRMS_MAP_KEY_ENV_VAR",
    "MAX_DAY_RANGE_DAYS",
    "MODIS_HIGH_CONFIDENCE_PERCENT",
    "MODIS_NOMINAL_CONFIDENCE_PERCENT",
    "REDACTED_MAP_KEY",
    "SUPPORTED_FIRMS_SOURCES",
    "FirmsDetectionSource",
    "FixtureDetectionSource",
    "cluster_detections",
]
