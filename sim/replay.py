"""Observed-data playback over a loaded incident package (retrospective, no interpolation).

Everything here replays historical evidence only; nothing is simulated. A perimeter
applies from its snapshot_at until the next snapshot. Damage points are post-fire
assessments with no time of damage and are never sequenced in time.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime, timedelta

from sim.geo import point_in_geometry
from sim.history import IncidentHistory, format_utc

MAX_TIMELINE_FRAMES = 10_000
PERIMETER_KIND = "satellite_derived_cumulative_estimate"
DAMAGE_REPLAY_ROLE = "postfire_outcome_inside_observed_perimeter"

TIMELINE_ASSUMPTIONS = [
    "Retrospective reconstruction: evidence is shown at its observation time, not when responders received it.",
    "A perimeter applies from its snapshot_at until the next snapshot; no interpolation between snapshots.",
]
TIMELINE_LIMITATIONS = [
    "Source availability time is unknown, so this is not a decision-time replay.",
    "FEDS perimeters are satellite-derived cumulative estimates at a nominal 12-hour cadence; "
    "spread between snapshots is not observed, and a held perimeter does not mean spread stopped.",
    "Cumulative mapped area can decrease between snapshots after source corrections; deltas are reported raw.",
    "Damage points are post-fire assessments with no time of damage; they must not be read as fire arrival times.",
]


def _require_aware(at: datetime) -> None:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("replay time must include a timezone")


def _snapshot_times(history: IncidentHistory) -> list[datetime]:
    return [p.snapshot_at for p in history.perimeters]


def _snapshot_index(times: list[datetime], at: datetime) -> int | None:
    """Index of the latest snapshot with snapshot_at <= at, or None before the first."""
    index = bisect_right(times, at) - 1
    return index if index >= 0 else None


def _coverage(times: list[datetime], at: datetime) -> str:
    if at < times[0]:
        return "before_first_observation"
    if at > times[-1]:
        return "after_last_observation"
    return "within_observation_window"


def _age_seconds(times: list[datetime], index: int | None, at: datetime) -> int | None:
    return None if index is None else int((at - times[index]).total_seconds())


@dataclass
class ReplayClock:
    """Simulation clock over the observation window. Never reads wall-clock time."""

    start: datetime
    end: datetime
    step: timedelta
    current: datetime

    def __post_init__(self) -> None:
        for value in (self.start, self.end, self.current):
            _require_aware(value)
        if self.step <= timedelta(0):
            raise ValueError("clock step must be positive")
        if self.start > self.end:
            raise ValueError("clock start must not be after end")
        self.seek(self.current)

    @classmethod
    def for_history(cls, history: IncidentHistory, step: timedelta = timedelta(hours=1)) -> ReplayClock:
        start, end = history.perimeters[0].snapshot_at, history.perimeters[-1].snapshot_at
        return cls(start=start, end=end, step=step, current=start)

    def seek(self, at: datetime) -> None:
        """Move to `at`, clamped to [start, end]."""
        _require_aware(at)
        self.current = min(max(at, self.start), self.end)

    def advance(self, steps: int = 1) -> datetime:
        """Move by `steps` ticks (negative rewinds), clamped; return the new time."""
        self.seek(self.current + steps * self.step)
        return self.current

    @property
    def at_end(self) -> bool:
        return self.current >= self.end


def observed_frame(history: IncidentHistory, at: datetime, *, include_damage: bool = True) -> dict:
    """GeoJSON frame of the latest observed perimeter at `at`, plus damage inside it.

    `replay` metadata is a superset of tools.replay_camp_history.frame_at's.
    """
    _require_aware(at)
    times = _snapshot_times(history)
    index = _snapshot_index(times, at)
    snapshot = history.perimeters[index] if index is not None else None
    features: list[dict] = []
    damage_inside = 0
    if snapshot is not None:
        features.append(snapshot.feature)
        if include_damage:
            for point in history.damage:
                if point_in_geometry(point.lon, point.lat, snapshot.geometry):
                    features.append(_damage_feature(point.feature, DAMAGE_REPLAY_ROLE))
                    damage_inside += 1
    next_index = 0 if index is None else index + 1
    return {
        "type": "FeatureCollection",
        "features": features,
        "replay": {
            "mode": "retrospective",
            "incident_id": history.incident_id,
            "package_version": history.package_version,
            "requested_at": format_utc(at),
            "snapshot_at": format_utc(snapshot.snapshot_at) if snapshot else None,
            "snapshot_age_seconds": _age_seconds(times, index, at),
            "coverage": _coverage(times, at),
            "interpolation": "none",
            "perimeter_kind": PERIMETER_KIND,
            "source_availability": history.manifest["layers"]["fire_perimeters"]["availability_status"],
            # The package's own label (FEDS perimeters are "reconstructed" satellite estimates).
            "evidence_class": snapshot.feature["properties"]["evidence_class"] if snapshot else None,
            "snapshot_index": index,
            "area_km2": snapshot.area_km2 if snapshot else None,
            # Counted only when include_damage is set; None means not evaluated.
            "damage_inside_count": damage_inside if include_damage else None,
            "next_snapshot_at": format_utc(times[next_index]) if next_index < len(times) else None,
        },
    }


def _damage_feature(feature: dict, replay_role: str) -> dict:
    properties = {
        **feature["properties"],
        "replay_role": replay_role,
        "temporal_role": "postfire_assessment",
        "damage_time": None,
    }
    return {**feature, "properties": properties}


def perimeter_events(history: IncidentHistory) -> list[dict]:
    """One perimeter_observed event per snapshot, in time order, with raw (unclamped) growth."""
    events = []
    previous = None
    for index, snapshot in enumerate(history.perimeters):
        growth = gap_hours = rate = None
        if previous is not None:
            growth = snapshot.area_km2 - previous.area_km2
            gap_hours = (snapshot.snapshot_at - previous.snapshot_at).total_seconds() / 3600
            rate = growth / gap_hours if gap_hours > 0 else None
        events.append({
            "type": "perimeter_observed",
            "at": format_utc(snapshot.snapshot_at),
            "snapshot_index": index,
            "area_km2": snapshot.area_km2,
            "growth_km2": growth,
            "growth_rate_km2_per_hour": rate,
            "gap_hours": gap_hours,
            "evidence_class": snapshot.feature["properties"]["evidence_class"],
            "time_precision": snapshot.feature["properties"].get("time_precision"),
        })
        previous = snapshot
    return events


def timeline(
    history: IncidentHistory,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    step: timedelta = timedelta(hours=1),
) -> dict:
    """Compact frontend animation payload: each geometry once, per-tick frames reference it by index."""
    times = _snapshot_times(history)
    start = times[0] if start is None else start
    end = times[-1] if end is None else end
    _require_aware(start)
    _require_aware(end)
    if step <= timedelta(0):
        raise ValueError("timeline step must be positive")
    if start > end:
        raise ValueError("timeline start must not be after end")
    frame_count = int((end - start) / step) + 1
    if frame_count > MAX_TIMELINE_FRAMES:
        raise ValueError(f"timeline would have {frame_count} frames; limit is {MAX_TIMELINE_FRAMES}, use a larger step")

    frames = []
    for tick in range(frame_count):
        at = start + tick * step
        index = _snapshot_index(times, at)
        frames.append({
            "at": format_utc(at),
            "snapshot_index": index,
            "snapshot_age_seconds": _age_seconds(times, index, at),
            "coverage": _coverage(times, at),
        })

    damage_features = [_damage_feature(p.feature, "postfire_assessment_overlay") for p in history.damage]
    return {
        "kind": "observed_replay_timeline",
        "incident_id": history.incident_id,
        "package_version": history.package_version,
        "mode": "retrospective",
        "interpolation": "none",
        "perimeter_kind": PERIMETER_KIND,
        "source_availability": history.manifest["layers"]["fire_perimeters"]["availability_status"],
        "crs": "OGC:CRS84",
        "step_seconds": int(step.total_seconds()),
        "start": format_utc(start),
        "end": format_utc(end),
        "assumptions": TIMELINE_ASSUMPTIONS,
        "limitations": TIMELINE_LIMITATIONS,
        "perimeters": [
            {
                "snapshot_index": index,
                "snapshot_at": format_utc(snapshot.snapshot_at),
                "area_km2": snapshot.area_km2,
                "geometry": snapshot.geometry,
            }
            for index, snapshot in enumerate(history.perimeters)
        ],
        "frames": frames,
        "events": perimeter_events(history),
        "damage": {
            "count": len(damage_features),
            "temporal_role": "postfire_assessment",
            "features": damage_features,
        },
    }
