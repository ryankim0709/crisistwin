"""Simulated fire front from an ignition point, for the hours before the first satellite perimeter.

FEDS perimeters start after most of the Camp Fire evacuation. This module simulates
spread from an assumed ignition point and time, picks parameters by IoU against the
first observed perimeter (the only evidence in the package for that window), and
exports smoothed isochrones. Everything produced here is `simulated`.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sim.fire import MODEL_ID, MODEL_VERSION, FireParams, burned_mask, simulate_arrival
from sim.geo import Grid, mask_contour, rasterize
from sim.hindcast import score
from sim.history import IncidentHistory, format_utc

# Approximate origin near Pulga / Camp Creek Road and the widely reported ~06:30 PST start.
# Replace with the package's `fire_ignition` event once acquired (see data acquisition plan).
CAMP_IGNITION_LONLAT = (-121.434, 39.813)
CAMP_IGNITION_AT = datetime.fromisoformat("2018-11-08T14:30:00+00:00")
IGNITION_PROVENANCE = "assumed: approximate reported origin and time, not from the package"

FIREFRONT_ASSUMPTIONS = [
    "Ignition point and time are approximate assumptions, not package evidence.",
    "Parameters are chosen only to match the first satellite perimeter's extent; "
    "intermediate isochrones are model output, not observations.",
    "Uniform fuel, flat terrain, constant wind, no spotting: the real day-1 spread was spotting-driven, "
    "so arrival times inside the perimeter are illustrative.",
    "The calibrated front reaches eastern Paradise about 3.3 h after the assumed ignition; contemporary "
    "accounts suggest earlier arrival, which this model does not reproduce.",
]


def ignition_candidates() -> list[FireParams]:
    """Day-1 search space: north-east to east winds and very fast effective spread.

    Base rates are high because a contiguous-spread model must stand in for the
    long-range spotting that drove day-1 growth; they are effective, not physical, rates.
    """
    return [
        FireParams(base, wind_from, speed)
        for base in (24.0, 32.0, 48.0, 64.0)
        for wind_from in (45.0, 56.25, 67.5, 78.75)
        for speed in (5.0, 10.0, 15.0)
    ]


def calibrate_from_ignition(history: IncidentHistory, candidates: list[FireParams], *, cell_m: float = 200,
                            margin_m: float = 2000, ignition_lonlat: tuple[float, float] = CAMP_IGNITION_LONLAT,
                            ignition_at: datetime = CAMP_IGNITION_AT) -> tuple[FireParams, list[float], Grid, dict]:
    """Best candidate by IoU with the first observed perimeter. Returns (params, arrival, grid, record)."""
    target = history.perimeters[0]
    horizon_s = (target.snapshot_at - ignition_at).total_seconds()
    if horizon_s <= 0:
        raise ValueError("ignition must precede the first observed perimeter")
    grid = Grid.covering(history.perimeter_bbox, cell_m, margin_m)
    cell = grid.cell_of(*ignition_lonlat)
    if cell is None:
        raise ValueError("ignition point lies outside the simulation grid")
    ignition = bytearray(grid.size)
    ignition[cell] = 1
    observed = rasterize(grid, target.geometry)

    best = None
    table = []
    for params in candidates:
        arrival = simulate_arrival(grid, ignition, params, horizon_s)
        metrics = score(burned_mask(arrival, horizon_s), observed, grid.cell_area_km2)
        table.append({"params": params.to_dict(), "iou": metrics["iou"], "area_ratio": metrics["area_ratio"]})
        if best is None or metrics["iou"] > best[0]["iou"]:
            best = (metrics, params, arrival)
    metrics, params, arrival = best
    record = {
        "kind": "fire_ignition_calibration",
        "evidence_class": "simulated",
        "model": {"id": MODEL_ID, "version": MODEL_VERSION, "params": params.to_dict()},
        "ignition": {"coord": list(ignition_lonlat), "at": format_utc(ignition_at), "provenance": IGNITION_PROVENANCE},
        "target_snapshot_at": format_utc(target.snapshot_at),
        "metrics": metrics,
        "candidates": table,
        "assumptions": FIREFRONT_ASSUMPTIONS,
    }
    return params, arrival, grid, record


def isochrones(grid: Grid, arrival: list[float], t0: datetime, *, until: datetime,
               every: timedelta = timedelta(minutes=10)) -> list[dict]:
    """Smoothed simulated burned-area outlines at regular times after t0 (cumulative)."""
    step_s = every.total_seconds()
    if step_s <= 0:
        raise ValueError("isochrone interval must be positive")
    fronts = []
    count = int((until - t0).total_seconds() // step_s)
    for k in range(1, count + 1):
        t_s = k * step_s
        mask = burned_mask(arrival, t_s)
        cells = sum(mask)
        if not cells:
            continue
        fronts.append({
            "at": format_utc(t0 + timedelta(seconds=t_s)),
            "area_km2": round(cells * grid.cell_area_km2, 3),
            "evidence_class": "simulated",
            "geometry": mask_contour(grid, mask, min_cells=2),
        })
    return fronts


def arrival_lookup(grid: Grid, arrival: list[float], t0: datetime):
    """fire_area_at-style helper on the simulated front: burned geometry at t, or None."""
    cache: dict[int, dict | None] = {}

    def at(when: datetime, step_s: int = 300) -> dict | None:
        # Quantize to step_s so the traffic engine's per-geometry caches stay small.
        k = math.floor((when - t0).total_seconds() / step_s)
        if k < 0:
            return None
        if k not in cache:
            mask = burned_mask(arrival, k * step_s)
            cache[k] = mask_contour(grid, mask, smooth_iterations=0) if any(mask) else None
        return cache[k]

    return at
