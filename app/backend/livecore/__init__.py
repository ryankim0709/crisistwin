"""Pure live-drill computations (ADR 0012, docs/live-reports.md v2).

No Django, PyMongo, network or LLM imports here: every function takes plain values and
returns frozen dataclasses, so the API layer (``api/live``) can store and serve them and
the rules stay testable on their own.

Conventions: coordinates are WGS84 ``(lon, lat)`` tuples in decimal degrees; datetimes are
timezone-aware UTC; distances are meters unless a name ends in ``_km``; durations are
seconds unless a name ends in ``_min``. Drill time ("replay time", 2018) and wall time
(now) are never mixed in one value: names say which one they hold.
"""

from .drill import Drill, load_drill, replay_now
from .fire import FireEstimate, estimate_fire
from .planner import ZoneGuidance, plan
from .policy import Change, diff, is_auto_approvable
from .routing import Route, best_routes

__all__ = [
    "Change",
    "Drill",
    "FireEstimate",
    "Route",
    "ZoneGuidance",
    "best_routes",
    "diff",
    "estimate_fire",
    "is_auto_approvable",
    "load_drill",
    "plan",
    "replay_now",
]
