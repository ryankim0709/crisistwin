"""Hindcast the fire-spread model against observed perimeters, and calibrate it without look-ahead."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from sim import SIM_VERSION
from sim.fire import MODEL_ID, MODEL_VERSION, FireParams, burned_mask, simulate_arrival
from sim.geo import Grid, mask_to_geometry, rasterize
from sim.history import IncidentHistory, format_utc

ASSUMPTIONS = [
    "Uniform fuel everywhere on the grid; the package has no fuel, terrain, or weather layers.",
    "Flat terrain: no slope effect on spread rate.",
    "Constant wind speed and direction for the whole run; wind is a model parameter, not an observation.",
    "Fire ellipse shape from the Alexander (1985) length-to-breadth relation; head rate linear in wind speed.",
    "Ignition is the rasterized observed perimeter at t0 (cell centres inside the polygon).",
    "No spotting, suppression, barriers, or burnout; burned area is cumulative.",
]

LIMITATIONS = [
    "Simulation starts from a cumulative perimeter, so the start area is already burned; "
    "the 'growth' metrics isolate predicted spread beyond it and are the more informative score.",
    "Observed perimeters are satellite-derived (FEDS) estimates at a nominal 12-hour cadence, "
    "not exact fire arrival times.",
    "Uniform fuel and no terrain: the model cannot represent unburnable areas, fuel breaks, or slope runs.",
    "Constant wind cannot follow wind shifts or the weakening of the day-1 downslope wind event.",
    "No suppression or containment effects are modelled.",
    "Grid resolution limits detail; the domain is the perimeter bounding box plus a margin, "
    "and fire is truncated at the grid edge.",
    "Results are a planning experiment, not an operational fire prediction.",
]


@dataclass(frozen=True)
class _Observed:
    snapshot_at: datetime
    elapsed_s: float
    observed_area_km2: float  # area reported by the source, before rasterization
    mask: bytearray


@dataclass(frozen=True)
class _Setup:
    grid: Grid
    t0: datetime
    ignition: bytearray
    observed: tuple[_Observed, ...]  # snapshots with 0 < elapsed <= horizon, ascending


def score(simulated: bytearray, observed: bytearray, cell_area_km2: float) -> dict:
    """Cell-overlap metrics between two masks on the same grid."""
    if len(simulated) != len(observed):
        raise ValueError("masks must have the same size")
    hit = miss = false_alarm = 0
    for s, o in zip(simulated, observed):
        if s and o:
            hit += 1
        elif o:
            miss += 1
        elif s:
            false_alarm += 1
    union = hit + miss + false_alarm
    sim_n, obs_n = hit + false_alarm, hit + miss
    return {
        "iou": hit / union if union else 1.0,
        "dice": 2 * hit / (sim_n + obs_n) if sim_n + obs_n else 1.0,
        "hit_km2": hit * cell_area_km2,
        "miss_km2": miss * cell_area_km2,
        "false_alarm_km2": false_alarm * cell_area_km2,
        "simulated_km2": sim_n * cell_area_km2,
        "observed_km2": obs_n * cell_area_km2,
        "area_ratio": sim_n / obs_n if obs_n else None,
    }


def _setup(history: IncidentHistory, start_index: int, horizon_hours: float, cell_m: float, margin_m: float) -> _Setup:
    if not 0 <= start_index < len(history.perimeters):
        raise ValueError(f"start_index {start_index} out of range 0..{len(history.perimeters) - 1}")
    if not horizon_hours > 0:
        raise ValueError(f"horizon_hours must be positive, got {horizon_hours}")
    grid = Grid.covering(history.perimeter_bbox, cell_m, margin_m=margin_m)
    start = history.perimeters[start_index]
    horizon_s = horizon_hours * 3600
    observed = []
    for snapshot in history.perimeters[start_index + 1:]:
        elapsed_s = (snapshot.snapshot_at - start.snapshot_at).total_seconds()
        if elapsed_s > horizon_s:
            break
        if elapsed_s > 0:
            observed.append(_Observed(snapshot.snapshot_at, elapsed_s, snapshot.area_km2,
                                      rasterize(grid, snapshot.geometry)))
    return _Setup(grid, start.snapshot_at, rasterize(grid, start.geometry), tuple(observed))


def _growth(mask: bytearray, ignition: bytearray) -> bytearray:
    return bytearray(m and not i for m, i in zip(mask, ignition))


def _snapshot_entries(setup: _Setup, arrival: list[float], window_s: tuple[float, float],
                      include_geometry: bool) -> list[dict]:
    area = setup.grid.cell_area_km2
    entries = []
    for obs in setup.observed:
        if not window_s[0] < obs.elapsed_s <= window_s[1]:
            continue
        simulated = burned_mask(arrival, obs.elapsed_s)
        entry = {
            "snapshot_at": format_utc(obs.snapshot_at),
            "elapsed_hours": obs.elapsed_s / 3600,
            "source_area_km2": obs.observed_area_km2,
            "metrics": score(simulated, obs.mask, area),
            # Growth beyond the start perimeter only; the start area is excluded from both masks.
            "growth": score(_growth(simulated, setup.ignition), _growth(obs.mask, setup.ignition), area),
            # Baseline: the fire stays at its start perimeter.
            "persistence_iou": score(setup.ignition, obs.mask, area)["iou"],
        }
        if include_geometry:
            entry["simulated_geometry"] = mask_to_geometry(setup.grid, simulated)
        entries.append(entry)
    return entries


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _summary(entries: list[dict]) -> dict:
    return {
        "snapshot_count": len(entries),
        "mean_iou": _mean([e["metrics"]["iou"] for e in entries]),
        "mean_dice": _mean([e["metrics"]["dice"] for e in entries]),
        "mean_growth_iou": _mean([e["growth"]["iou"] for e in entries]),
        "mean_persistence_iou": _mean([e["persistence_iou"] for e in entries]),
        "final_area_ratio": entries[-1]["metrics"]["area_ratio"] if entries else None,
    }


def _record(history: IncidentHistory, setup: _Setup, params: FireParams, horizon_hours: float,
            entries: list[dict], start_index: int) -> dict:
    return {
        "kind": "fire_hindcast",
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict()},
        "sim_version": SIM_VERSION,
        "incident_id": history.incident_id,
        "package_version": history.package_version,
        "grid": setup.grid.to_dict(),
        "start_index": start_index,
        "t0": format_utc(setup.t0),
        "horizon_hours": horizon_hours,
        "ignition_km2": sum(setup.ignition) * setup.grid.cell_area_km2,
        "assumptions": list(ASSUMPTIONS),
        "limitations": list(LIMITATIONS),
        "snapshots": entries,
        "summary": _summary(entries),
    }


def run_hindcast(history: IncidentHistory, params: FireParams, *, start_index: int = 0, horizon_hours: float = 48,
                 cell_m: float = 200, margin_m: float = 2000, include_geometry: bool = False) -> dict:
    """Simulate from perimeter[start_index] and score every observed snapshot within the horizon."""
    setup = _setup(history, start_index, horizon_hours, cell_m, margin_m)
    horizon_s = horizon_hours * 3600
    arrival = simulate_arrival(setup.grid, setup.ignition, params, horizon_s)
    entries = _snapshot_entries(setup, arrival, (0.0, horizon_s), include_geometry)
    return _record(history, setup, params, horizon_hours, entries, start_index)


def calibrate(history: IncidentHistory, candidates: Iterable[FireParams], *, start_index: int = 0,
              train_hours: float = 24, test_hours: float = 48, cell_m: float = 200, margin_m: float = 2000) -> dict:
    """Pick params by mean IoU on (t0, t0+train_hours]; report the pick on (train_hours, test_hours] separately.

    Candidates are simulated only to the training horizon, so selection never sees test snapshots.
    Ties keep the earliest candidate.
    """
    if not 0 < train_hours < test_hours:
        raise ValueError("need 0 < train_hours < test_hours")
    candidates = list(candidates)
    if not candidates:
        raise ValueError("no calibration candidates")
    setup = _setup(history, start_index, test_hours, cell_m, margin_m)
    train_s, test_s = train_hours * 3600, test_hours * 3600
    if not any(o.elapsed_s <= train_s for o in setup.observed):
        raise ValueError(f"no observed snapshots within {train_hours} h of t0")
    train = []
    best_index, best_iou = 0, -1.0
    for index, params in enumerate(candidates):
        arrival = simulate_arrival(setup.grid, setup.ignition, params, train_s)
        summary = _summary(_snapshot_entries(setup, arrival, (0.0, train_s), False))
        train.append({"params": params.to_dict(), **summary})
        if summary["mean_iou"] > best_iou:
            best_index, best_iou = index, summary["mean_iou"]
    best = candidates[best_index]
    arrival = simulate_arrival(setup.grid, setup.ignition, best, test_s)
    test_entries = _snapshot_entries(setup, arrival, (train_s, test_s), False)
    test = _record(history, setup, best, test_hours, test_entries, start_index)
    test["window_hours"] = [train_hours, test_hours]
    return {
        "kind": "fire_calibration",
        "evidence_class": "simulated",
        "selection": {"metric": "mean_iou", "window_hours": [0, train_hours], "candidate_count": len(candidates)},
        "best_index": best_index,
        "best_params": best.to_dict(),
        "train": train,
        "test": test,
    }


def default_candidates() -> list[FireParams]:
    """3 base rates x 8 wind directions x 2 speeds (48 candidates); wind coefficient at its default."""
    return [
        FireParams(base_spread_m_per_min=base, wind_from_deg=direction, wind_speed_m_s=speed)
        for base in (1.0, 2.0, 4.0)
        for direction in range(0, 360, 45)
        for speed in (5.0, 12.0)
    ]
