"""Current best estimate of where the fire is now (never a forecast).

Contract: docs/live-reports.md "Fire estimate".
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from .drill import Drill, FireObservation, FireSnapshot
from .geo import LonLat, MultiPolygon

FIRE_OBSERVATION_WINDOW_MIN = 60
"""Observations shown with the estimate: drill time in [replay_now - 60 min, replay_now]."""

FireMethod = Literal["satellite_perimeter", "model_nowcast", "none"]
FireEvidence = Literal["reconstructed", "simulated", "none"]


@dataclass(frozen=True)
class FireEstimate:
    as_of: datetime | None
    """Drill time of the source geometry; None when ``method`` is ``none``."""
    method: FireMethod
    label: str
    """``"Satellite perimeter, HH:MM drill time"`` | ``"Model estimate, HH:MM drill time"`` | ``"No fire estimate yet"``."""
    geometry: MultiPolygon | None
    observations: tuple[FireObservation, ...]
    """Newest first."""
    evidence_class: FireEvidence


def estimate_fire(
    drill: Drill,
    replay_now: datetime,
    confirmed_fire_points: Sequence[FireObservation] = (),
    spots: Sequence[tuple[datetime, LonLat, float]] = (),
) -> FireEstimate:
    """Newest of the observed perimeters and simulated fronts with ``at <= replay_now``.

    Ties prefer the perimeter. ``observations`` merges ``drill.observations`` and
    ``confirmed_fire_points`` (confirmed ``fire_seen`` reports, ``source="field_report"``,
    ``at`` = report ``replay_at``) inside the ``FIRE_OBSERVATION_WINDOW_MIN`` window.

    Confirmed field reports are returned as observations only; they are not buffered into
    ``geometry``, so the area stays exactly the labeled source (perimeter or model front).

    ``spots`` are drill-inject spot ignitions ``(at, coord, radius_m)`` with ``at <= replay_now``
    (``livecore.injects.spots_due``). They are added to ``geometry`` as small circles, the label
    says so and ``evidence_class`` becomes ``simulated``; the source itself is unchanged.
    """
    estimate = _estimate(drill, replay_now, confirmed_fire_points)
    if not spots:
        return estimate
    from .injects import SPOT_LABEL, circle

    areas = tuple(p for _, coord, radius in spots for p in circle(coord, radius))
    base = tuple(estimate.geometry or ())
    label = f"{estimate.label} + {SPOT_LABEL}" if estimate.method != "none" else f"Fire estimate: {SPOT_LABEL}"
    return FireEstimate(
        as_of=estimate.as_of or spots[-1][0],
        method=estimate.method if estimate.method != "none" else "model_nowcast",
        label=label,
        geometry=base + areas,
        observations=estimate.observations,
        evidence_class="simulated",
    )


def _estimate(drill: Drill, replay_now: datetime, confirmed_fire_points: Sequence[FireObservation]) -> FireEstimate:
    perimeter = _latest(drill.perimeters, replay_now)
    front = _latest(drill.fronts, replay_now)
    source: FireSnapshot | None
    if perimeter is not None and (front is None or perimeter.at >= front.at):
        source = perimeter
    else:
        source = front

    window_start = replay_now - timedelta(minutes=FIRE_OBSERVATION_WINDOW_MIN)
    observations = [
        o for o in (*drill.observations, *confirmed_fire_points)
        if window_start <= o.at <= replay_now
    ]
    observations.sort(key=lambda o: (o.at, o.id), reverse=True)

    if source is None:
        return FireEstimate(
            as_of=None, method="none", label=fire_label("none", None), geometry=None,
            observations=tuple(observations), evidence_class="none",
        )
    method: FireMethod = "satellite_perimeter" if source.source == "perimeter" else "model_nowcast"
    evidence: FireEvidence = "reconstructed" if source.source == "perimeter" else "simulated"
    return FireEstimate(
        as_of=source.at,
        method=method,
        label=fire_label(method, source.at),
        geometry=source.geometry,
        observations=tuple(observations),
        evidence_class=evidence,
    )


def _latest(snapshots: Sequence[FireSnapshot], replay_now: datetime) -> FireSnapshot | None:
    """``snapshots`` are sorted by ``at`` ascending."""
    found = None
    for snap in snapshots:
        if snap.at > replay_now:
            break
        found = snap
    return found


def fire_label(method: FireMethod, as_of: datetime | None) -> str:
    """Human label with method and drill time (HH:MM UTC), per the contract strings above."""
    if method == "none" or as_of is None:
        return "No fire estimate yet"
    hhmm = as_of.strftime("%H:%M")
    if method == "satellite_perimeter":
        return f"Satellite perimeter, {hhmm} drill time"
    return f"Model estimate, {hhmm} drill time"
