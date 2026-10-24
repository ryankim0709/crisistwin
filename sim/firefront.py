"""Simulated fire front from an ignition point, for the hours before the first satellite perimeter.

FEDS perimeters start after most of the Camp Fire evacuation. This module simulates
spread from an assumed ignition point and time, picks parameters by IoU against the
first observed perimeter (the only evidence in the package for that window), and
exports smoothed isochrones. Everything produced here is `simulated`.

`calibrate_rothermel` / `rothermel_fire` replace the assumed ignition and the perimeter-only fit with
package evidence: the fire_ignition event, NIST fire observations, and USGS terrain (rothermel-mtt).
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timedelta
from pathlib import Path

from sim.fire import (MODEL_ID, MODEL_VERSION, MOISTURE_SCENARIOS, ROTHERMEL_MODEL_ID, ROTHERMEL_MODEL_VERSION,
                      FireParams, RothermelParams, burned_mask, simulate_arrival, simulate_arrival_rothermel)
from sim.fire_obs import OBSERVATION_NOTES, first_per_cell, load_ignition, load_observations, split_scores
from sim.geo import Grid, mask_contour, rasterize
from sim.hindcast import score
from sim.history import IncidentHistory, format_utc
from sim.terrain import load_terrain

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


# --- rothermel-mtt front grounded in the evacuation package ------------------------------------------------
#
# Ignition time and place come from the package (fire_ignition event, NIST origin observation),
# terrain from its USGS 3DEP grid, and parameters are chosen by arrival-time error at NIST fire
# observations before CALIBRATION_CUTOFF only. Observations from the cutoff to the first FEDS
# perimeter are held out, and the perimeter IoU is reported but not used for selection.

CALIBRATION_CUTOFF = datetime.fromisoformat("2018-11-08T17:00:00+00:00")
SCORING_SLACK = timedelta(hours=2)  # run past the first perimeter so late arrivals are measured, not censored
SPOTTING_MIN_GAIN = 0.2  # spotting is chosen only if it cuts the training mean error by at least this fraction

ROTHERMEL_ASSUMPTIONS = [
    "Ignition time is the package's fire_ignition event (NIST TN 2252, 'approximately 06:20' PST) and its place is "
    "NIST fire observation 0001 (origin, first 911 report at 06:25 PST); both are reconstructed evidence.",
    "Surface spread rate from Rothermel (1972) with Albini (1976) weighting for one Scott & Burgan (2005) fuel model "
    "everywhere (assumed; the package has no fuel layer). No unburnable cells, roads or fuel breaks.",
    "Dead and live fuel moisture are a named scenario for the day (assumed, consistent with the extreme fire "
    "weather), not measurements.",
    "Constant 20-ft wind speed and direction for the whole run, reduced to midflame wind by the fuel model's "
    "unsheltered wind adjustment factor (Andrews 2012); wind is a fitted parameter, not an observation.",
    "Slope from USGS 3DEP 1 arc-second elevation block-averaged to the fire grid; wind and slope combined as "
    "vectors (Rothermel 1972; Albini 1976), fire shape from the effective wind (Anderson 1983). Cells beyond the "
    "DEM's eastern edge are flat.",
    "Optional spotting is a simple seeded rule, not an ember transport model; whether it is on is stated in params.",
    "Parameters are chosen by arrival-time error at NIST observations before the calibration cutoff; later "
    "observations and the first satellite perimeter are used only for evaluation.",
]


# Chosen by `python3 -m sim.firefront` (rothermel_candidates, 200 runs, 200 m cells) on 2026-10-23: lowest
# training mean arrival error at NIST observations before 17:00Z. Frozen so bundle builds run one simulation.
ROTHERMEL_CHOSEN_PARAMS = RothermelParams(wind_from_deg=67.5, wind_20ft_m_s=18.0, moisture="extreme",
                                          spot_distance_m=3000.0, spot_probability=0.15, seed=7)
ROTHERMEL_PARAMS_SOURCE = ("frozen from the rothermel_candidates search (200 runs) on 2026-10-23; "
                           "rerun with `python3 -m sim.firefront`")


def rothermel_candidates() -> list[RothermelParams]:
    """Bounded search: north-east to east winds, strong 20-ft speeds, two moisture scenarios, spotting off/on."""
    spotting = ((0.0, 0.0), (2000.0, 0.15), (2000.0, 0.3), (3000.0, 0.15), (3000.0, 0.3))
    return [
        RothermelParams(wind_from, speed, moisture, spot_distance_m=dist, spot_probability=prob)
        for wind_from in (45.0, 56.25, 67.5, 78.75, 90.0)
        for speed in (9.0, 12.0, 15.0, 18.0)  # 20-ft m/s: about 20-40 mph sustained
        for moisture in MOISTURE_SCENARIOS
        for dist, prob in spotting
    ]


def calibrate_rothermel(history: IncidentHistory, package: Path, candidates: list[RothermelParams] | None = None, *,
                        cell_m: float = 200, margin_m: float = 2000,
                        cutoff: datetime = CALIBRATION_CUTOFF) -> tuple[RothermelParams, list[float], Grid, dict]:
    """Calibrate rothermel-mtt on NIST observations before `cutoff`; evaluate on later ones and the first perimeter.

    `package` is the camp-2018-evacuation package holding the observations, events and terrain.
    Returns (params, arrival truncated at the first perimeter, grid, record) like calibrate_from_ignition.
    """
    started = time.perf_counter()
    candidates = candidates or rothermel_candidates()
    target = history.perimeters[0]
    grid = Grid.covering(history.perimeter_bbox, cell_m, margin_m)
    terrain = load_terrain(package, grid)
    observations = load_observations(package)
    ignition_src = load_ignition(package, observations)
    t0 = ignition_src.at
    perimeter_s = (target.snapshot_at - t0).total_seconds()
    if perimeter_s <= 0 or cutoff > target.snapshot_at:
        raise ValueError("ignition, calibration cutoff and first perimeter are out of order")
    horizon_s = (target.snapshot_at + SCORING_SLACK - t0).total_seconds()
    cell = grid.cell_of(ignition_src.lon, ignition_src.lat)
    if cell is None:
        raise ValueError("ignition point lies outside the simulation grid")
    ignition = bytearray(grid.size)
    ignition[cell] = 1
    targets = [t for t in first_per_cell(grid, observations) if t[0] != cell]
    observed = rasterize(grid, target.geometry)

    def evaluate(params: RothermelParams) -> tuple[dict, list[float]]:
        arrival = simulate_arrival_rothermel(grid, ignition, params, horizon_s, terrain)
        scores = split_scores(arrival, t0, targets, horizon_s, cutoff=cutoff, until=target.snapshot_at)
        perimeter = score(burned_mask(arrival, perimeter_s), observed, grid.cell_area_km2)
        return {**scores, "perimeter_iou": perimeter["iou"], "perimeter_area_ratio": perimeter["area_ratio"]}, arrival

    table, best = [], {}
    for params in candidates:
        metrics, arrival = evaluate(params)
        table.append({"params": params.to_dict(), **metrics})
        key = params.spotting
        if key not in best or metrics["train"]["mean_abs_error_min"] < best[key][0]["train"]["mean_abs_error_min"]:
            best[key] = (metrics, params, arrival)
    no_spot = best.get(False)
    spot = best.get(True)
    use_spot = spot is not None and (no_spot is None or spot[0]["train"]["mean_abs_error_min"]
                                     <= (1 - SPOTTING_MIN_GAIN) * no_spot[0]["train"]["mean_abs_error_min"])
    metrics, params, arrival = spot if use_spot else no_spot
    truncated = [a if a <= perimeter_s else math.inf for a in arrival]
    record = {
        "kind": "fire_ignition_calibration",
        "evidence_class": "simulated",
        "model": {"id": ROTHERMEL_MODEL_ID, "version": ROTHERMEL_MODEL_VERSION, "params": params.to_dict()},
        # `provenance` stays a string (bundle contract); the structured sources go in `provenance_detail`.
        "ignition": {"coord": [ignition_src.lon, ignition_src.lat], "at": format_utc(t0),
                     "provenance": "reconstructed: time from the package fire_ignition event (NIST TN 2252, "
                                   "approximate), place from NIST fire observation 0001 (origin)",
                     "provenance_detail": ignition_src.provenance},
        "target_snapshot_at": format_utc(target.snapshot_at),
        "metrics": {"iou": metrics["perimeter_iou"], "area_ratio": metrics["perimeter_area_ratio"],
                    "observed_cells": sum(observed)},
        "observation_scores": {
            "source": "NIST fire observations (reconstructed), earliest non-residual per fire cell, ignition cell "
                      "excluded",
            "cutoff": format_utc(cutoff), "held_out_until": format_utc(target.snapshot_at),
            "train": metrics["train"], "held_out": metrics["held_out"],
            "objective": "train mean_abs_error_min",
        },
        "spotting_selection": {
            "rule": f"spotting used only if it lowers the training mean error by >= {SPOTTING_MIN_GAIN:.0%}",
            "chosen": use_spot,
            "best_without": no_spot and {"params": no_spot[1].to_dict(), "train": no_spot[0]["train"],
                                         "held_out": no_spot[0]["held_out"], "perimeter_iou": no_spot[0]["perimeter_iou"]},
            "best_with": spot and {"params": spot[1].to_dict(), "train": spot[0]["train"],
                                   "held_out": spot[0]["held_out"], "perimeter_iou": spot[0]["perimeter_iou"]},
        },
        "terrain": terrain.summary(),
        "grid": {"cell_m": cell_m, "ncols": grid.ncols, "nrows": grid.nrows},
        "candidates": table,
        "runtime_s": round(time.perf_counter() - started, 1),
        "assumptions": ROTHERMEL_ASSUMPTIONS,
        "observation_notes": OBSERVATION_NOTES,
    }
    return params, truncated, grid, record


# Cells of buffer around the first satellite perimeter the modelled front may still burn
# (perimeter mapping error and 200 m rasterization), before the constraint cuts it off.
PERIMETER_CONSTRAINT_BUFFER_CELLS = 2


def constrain_to_perimeter(grid: Grid, arrival: list[float], perimeter) -> tuple[list[float], dict]:
    """Keep modelled burning only inside the first satellite perimeter (plus a small buffer).

    The real fire was inside that perimeter at its snapshot time, so the model must not burn
    beyond it before then (with constant wind it otherwise runs far too far west). Cells outside
    become unburned. The constraint uses later evidence, so the front is a reconstruction for
    replay, not a forecast.
    """
    inside = rasterize(grid, perimeter.geometry)
    allowed = bytearray(inside)
    for _ in range(PERIMETER_CONSTRAINT_BUFFER_CELLS):
        grown = bytearray(allowed)
        for i, v in enumerate(allowed):
            if v:
                row, col = divmod(i, grid.ncols)
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    r, c = row + dr, col + dc
                    if 0 <= r < grid.nrows and 0 <= c < grid.ncols:
                        grown[r * grid.ncols + c] = 1
        allowed = grown
    removed = sum(1 for a, ok in zip(arrival, allowed) if math.isfinite(a) and not ok)
    constrained = [a if ok else math.inf for a, ok in zip(arrival, allowed)]
    return constrained, {
        "kind": "clipped_to_first_satellite_perimeter",
        "perimeter_at": format_utc(perimeter.snapshot_at),
        "buffer_m": PERIMETER_CONSTRAINT_BUFFER_CELLS * grid.cell_m,
        "cells_removed": removed,
        "area_removed_km2": round(removed * grid.cell_area_km2, 1),
        "note": "Model front limited to the first satellite perimeter (plus buffer): uses later evidence, so "
                "this is a replay reconstruction, not a forecast. Calibration scores are for the unclipped model.",
    }


def rothermel_fire(history: IncidentHistory, package: Path, end: datetime,
                   params: RothermelParams = ROTHERMEL_CHOSEN_PARAMS,
                   params_source: str = ROTHERMEL_PARAMS_SOURCE) -> tuple[dict, tuple]:
    """`fire_simulated` block and (grid, arrival, t0, lookup) from rothermel-mtt, in the shape of
    sim.bundle._simulated_fire, plus model provenance and NIST observation scores.

    `params` other than the frozen choice (e.g. a counterfactual wind) are scored the same way;
    say where they came from in `params_source`.
    """
    params, arrival, grid, record = calibrate_rothermel(history, package, [params])
    arrival, constraint = constrain_to_perimeter(grid, arrival, history.perimeters[0])
    t0 = datetime.fromisoformat(record["ignition"]["at"].replace("Z", "+00:00"))
    until = min(end, history.perimeters[0].snapshot_at)
    m_per_deg_lat = grid._m_per_deg_lat
    scores = record["observation_scores"]
    held_out = scores["held_out"]
    block = {
        "evidence_class": "simulated",
        "model": record["model"],
        "ignition": record["ignition"],
        "calibration": {
            "target_snapshot_at": record["target_snapshot_at"],
            "iou": record["metrics"]["iou"],
            "area_ratio": record["metrics"]["area_ratio"],
            "method": "minimum train mean arrival error at NIST fire observations before the cutoff; "
                      "perimeter IoU is evaluation only",
            "observations": scores,
            "perimeter": {"snapshot_at": record["target_snapshot_at"], "iou": record["metrics"]["iou"],
                          "area_ratio": record["metrics"]["area_ratio"], "n_cells": record["metrics"]["observed_cells"],
                          "cell_m": grid.cell_m, "role": "evaluation only"},
            "params_source": params_source,
            "headline": f"median arrival error {held_out['median_abs_error_min']:.0f} min on {held_out['n']} held-out "
                        f"NIST observations ({scores['cutoff'][11:16]}-{scores['held_out_until'][11:16]}Z); "
                        f"{scores['train']['median_abs_error_min']:.0f} min on {scores['train']['n']} calibration "
                        "observations",
            "runtime_s": record["runtime_s"],
        },
        "terrain": record["terrain"],
        "constraint": constraint,
        "fronts": isochrones(grid, arrival, t0, until=until),
        "arrival_grid": {
            "origin_lon": grid.origin_lon, "origin_lat": grid.origin_lat, "cell_m": grid.cell_m,
            "ncols": grid.ncols, "nrows": grid.nrows,
            "m_per_deg_lon": grid._m_per_deg_lon, "m_per_deg_lat": m_per_deg_lat,
            "t0": record["ignition"]["at"],
            "minutes": [round(a / 60) if math.isfinite(a) else None for a in arrival],
        },
        "assumptions": [*ROTHERMEL_ASSUMPTIONS, *OBSERVATION_NOTES[1:]],
    }
    return block, (grid, arrival, t0, arrival_lookup(grid, arrival, t0))


def main() -> None:
    """Rerun the rothermel-mtt parameter search and print the choice (does not edit ROTHERMEL_CHOSEN_PARAMS)."""
    import argparse
    import json

    from sim.history import load_history

    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--package", type=Path, required=True, help="perimeter package (camp-2018-paradise-slice)")
    parser.add_argument("--roads-package", type=Path, required=True,
                        help="camp-2018-evacuation package with NIST fire observations and terrain")
    parser.add_argument("--cell-m", type=float, default=200)
    parser.add_argument("--output", type=Path, help="write the full calibration record (JSON)")
    args = parser.parse_args()
    params, _, _, record = calibrate_rothermel(load_history(args.package), args.roads_package, cell_m=args.cell_m)
    if args.output:
        args.output.write_text(json.dumps(record, indent=1, allow_nan=False))
    print(json.dumps({"chosen": params.to_dict(), "observation_scores": record["observation_scores"],
                      "perimeter": record["metrics"], "runtime_s": record["runtime_s"],
                      "frozen_default_matches": params == ROTHERMEL_CHOSEN_PARAMS}, indent=1))


if __name__ == "__main__":
    main()
