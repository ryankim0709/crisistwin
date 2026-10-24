"""Precomputed what-if (counterfactual) variants of the Camp Fire replay bundle.

Each variant is a pure transformation of the baseline inputs (scenario events, zones,
traffic params, simulated fire front) and is run through the same `build_bundle` path
as the baseline. Seed, clock, network, demand, destinations and model versions are
asserted identical; only the listed changes differ. A variant file references the
baseline bundle for roads, zones and perimeters and carries its own traffic, events,
insights, optional simulated fire, and deltas against the baseline. Contract:
docs/replay-bundle.md, section "Variants". Everything here is `simulated`.

Run from the repository root:
  python3 -m sim.variants --package data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65 \
    --roads-package data/incidents/camp-2018-evacuation/b1b318c16bbd3270 \
    --baseline app/public/replays/camp-2018.json --output-dir app/public/replays/camp-2018.variants
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

from tools.build_camp_history import SourceError

from sim import SIM_VERSION
from sim.bundle import _fire_area_lookup, _simulated_fire, build_bundle
from sim.fire import ROTHERMEL_MODEL_ID, FireParams
from sim.firefront import (FIREFRONT_ASSUMPTIONS, ROTHERMEL_CHOSEN_PARAMS, arrival_lookup, calibrate_from_ignition,
                           isochrones, rothermel_fire)
from sim.geo import EARTH_RADIUS_M
from sim.history import IncidentHistory, format_utc, load_history, parse_utc
from sim.scenario import camp_replay_inputs
from sim.traffic import (
    CONTRAFLOW_END_EVENT_TYPES, CONTRAFLOW_START_EVENT_TYPES, MODEL_ID as TRAFFIC_MODEL_ID,
    MODEL_VERSION as TRAFFIC_MODEL_VERSION, TrafficEvent, TrafficParams,
)

KIND = "crisistwin_variant"
INDEX_KIND = "crisistwin_variant_index"
SCHEMA_VERSION = "1.0.0"
BASELINE_FILE = "camp-2018.json"
COMPARE_ARRIVED_AT = ("2018-11-08T17:00:00Z", "2018-11-08T18:00:00Z", "2018-11-08T20:00:00Z")

# Skyway corridor between Paradise's west edge and the Chico city limit (lon/lat bbox).
# In the 2018 OSM extract the Paradise-Chico stretch is tagged "Skyway Road" (divided trunk);
# "Skyway" covers only the in-town segments and the westernmost trunk pieces. Both names are
# selected, and an edge is taken when its midpoint lies in the bbox.
SKYWAY_NAMES = ("Skyway", "Skyway Road")
SKYWAY_CORRIDOR_BBOX = (-121.79, 39.69, -121.655, 39.75)
SKYWAY_CLOSED_AT = "2018-11-08T16:00:00Z"  # 08:00 PST
RESPONSE_DELAY_FACTOR = 2.0
WIND_SHIFT_DEG = -30.0  # toward north: wind_from 67.5 -> 37.5 deg (both fire models' calibrated wind is 67.5)
OPTIMIZER_BUDGET_EVALS = 42

COMMON_LIMITATIONS = [
    "Counterfactual planning experiment on fixture demand (2 km zone grid, synthetic 15,000 vehicles) and "
    "fixture order times; not a reconstruction of what would have happened in 2018.",
    "One seed: response delays are a single draw shared with the baseline; deltas are not tested across seeds "
    "and small differences should not be read as significant.",
    "Planning experiment from a simulation; not operational instructions.",
]


class VariantUnavailable(Exception):
    """The variant's inputs do not exist yet; it is skipped with this reason."""


@dataclass(frozen=True)
class RunInputs:
    scenario: dict
    params: TrafficParams
    fire: tuple  # (fire_simulated block, (grid, arrival, t0, lookup)) as from sim.bundle._simulated_fire


@dataclass(frozen=True)
class Context:
    history: IncidentHistory
    start: datetime
    end: datetime
    roads_package: Path | None = None  # needed to rebuild a rothermel-mtt front (observations, terrain)


@dataclass(frozen=True)
class Variant:
    id: str
    title: str
    question: str
    apply: Callable[[RunInputs, Context], tuple[RunInputs, list[str], dict]]  # -> inputs, changes, extra record


# --- baseline inputs


def baseline_inputs(roads_package: Path) -> tuple[dict, datetime, datetime]:
    """Scenario and clock exactly as `python3 -m sim ... bundle --roads-package` builds them."""
    scenario, start, end, _ = camp_replay_inputs(roads_package)
    return scenario, start, end


def _with_events(inputs: RunInputs, events) -> RunInputs:
    return replace(inputs, scenario={**inputs.scenario, "events": tuple(sorted(events, key=lambda ev: (ev.at, ev.id)))})


# --- variant transformations


def _skyway_closed(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    network = base.scenario["network"]
    w, s, e, n = SKYWAY_CORRIDOR_BBOX

    def mid(edge) -> tuple[float, float]:
        (x0, y0), (x1, y1) = network.nodes[edge.from_node], network.nodes[edge.to_node]
        return (x0 + x1) / 2, (y0 + y1) / 2

    chosen = [x for x in network.edges if x.name in SKYWAY_NAMES and w <= mid(x)[0] <= e and s <= mid(x)[1] <= n]
    if not chosen:
        raise VariantUnavailable("no Skyway edges found in the corridor bbox")
    at = parse_utc(SKYWAY_CLOSED_AT)
    closure = TrafficEvent(
        id="variant-skyway-closed", at=at, type="road_closed",
        label="Counterfactual: Skyway closed between Paradise and Chico (both directions)",
        evidence_class="simulated", time_precision="minute", edge_ids=tuple(x.id for x in chosen),
        source_id="variant:skyway-closed-0800",
    )
    length_km = sum(x.length_m for x in chosen) / 1000
    changes = [
        f"Added road_closed at {SKYWAY_CLOSED_AT} (08:00 PST) on {len(chosen)} directed edges "
        f"({length_km:.1f} km of directed edge length), never reopened in the clock window.",
        f"Selection: edge name in {list(SKYWAY_NAMES)} with endpoint-midpoint inside bbox {list(SKYWAY_CORRIDOR_BBOX)} "
        "(lon/lat, Paradise west edge to Chico city limit).",
        "Vehicles already on a closed edge at 16:00Z stop there until the end (engine limitation: no turning back).",
    ]
    contraflow = [ev.id for ev in base.scenario["events"]
                  if ev.type in CONTRAFLOW_START_EVENT_TYPES and set(ev.edge_ids) & set(closure.edge_ids)]
    if contraflow:
        changes.append(f"Overrides baseline contraflow on the closed edges ({', '.join(contraflow)}): a hard closure "
                       "wins over contraflow, so both directions stay closed.")
    extra = {"selection": {"names": list(SKYWAY_NAMES), "bbox": list(SKYWAY_CORRIDOR_BBOX),
                           "edge_ids": [x.id for x in chosen], "highways": sorted({x.highway for x in chosen})}}
    return _with_events(base, [*base.scenario["events"], closure]), changes, extra


def _all_at_once(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    orders = [ev for ev in base.scenario["events"] if ev.type == "evacuation_order" and ev.zone_ids]
    if not orders:
        raise VariantUnavailable("baseline has no evacuation orders")
    first = min(ev.at for ev in orders)
    last = max(ev.at for ev in orders)
    events = [replace(ev, at=first) if ev in orders else ev for ev in base.scenario["events"]]
    changes = [f"All {len(orders)} evacuation orders moved to the first order time {format_utc(first)} "
               f"(baseline spread {format_utc(first)} to {format_utc(last)}); order labels and evidence unchanged."]
    return _with_events(base, events), changes, {}


def _slower_response(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    old = base.params.response_delay_median_min
    params = replace(base.params, response_delay_median_min=old * RESPONSE_DELAY_FACTOR)
    changes = [
        f"TrafficParams.response_delay_median_min {old:g} -> {params.response_delay_median_min:g} min "
        f"(x{RESPONSE_DELAY_FACTOR:g}); sigma {base.params.response_delay_sigma:g} and cap "
        f"{base.params.response_delay_max_min:g} min unchanged.",
        "Same seed, so each packet's delay is its baseline delay x2, except draws capped at the maximum.",
        "Later departures move exposure from roads to homes: compare total_exposed_veh_min (road + origin), "
        "not exposed_veh_min alone.",
    ]
    return replace(base, params=params), changes, {}


def fixed_fire(history: IncidentHistory, params: FireParams, end: datetime) -> tuple[dict, tuple]:
    """Simulated front with fixed params, in the shape of `sim.bundle._simulated_fire`.

    Reuses the firefront calibration with a single candidate, so ignition, grid, horizon
    and IoU scoring are identical to the baseline's; only the params are not searched.
    """
    params, arrival, grid, record = calibrate_from_ignition(history, [params])
    t0 = parse_utc(record["ignition"]["at"])
    until = min(end, history.perimeters[0].snapshot_at)
    m_per_deg_lat = math.radians(1) * EARTH_RADIUS_M
    mid_lat = grid.origin_lat + grid.nrows * grid.cell_m / m_per_deg_lat / 2
    block = {
        "evidence_class": "simulated",
        "model": record["model"],
        "ignition": record["ignition"],
        "calibration": {"target_snapshot_at": record["target_snapshot_at"], "iou": record["metrics"]["iou"],
                        "area_ratio": record["metrics"]["area_ratio"], "fixed_params": True},
        "fronts": isochrones(grid, arrival, t0, until=until),
        "arrival_grid": {
            "origin_lon": grid.origin_lon, "origin_lat": grid.origin_lat, "cell_m": grid.cell_m,
            "ncols": grid.ncols, "nrows": grid.nrows,
            "m_per_deg_lon": m_per_deg_lat * math.cos(math.radians(mid_lat)), "m_per_deg_lat": m_per_deg_lat,
            "t0": record["ignition"]["at"],
            "minutes": [round(a / 60) if math.isfinite(a) else None for a in arrival],
        },
        "assumptions": [*FIREFRONT_ASSUMPTIONS,
                        "Counterfactual front: parameters are fixed, not fitted; its fit to the first perimeter is "
                        "reported in calibration but was not used to choose them."],
    }
    return block, (grid, arrival, t0, arrival_lookup(grid, arrival, t0))


def shifted_fire(base_fire: tuple, ctx: Context, shift_deg: float) -> tuple:
    """Counterfactual front: the baseline's fire model and params with only wind_from_deg shifted by shift_deg.

    Same ignition, grid and (for rothermel-mtt) terrain as the baseline, so `basis` is unchanged. Shared by the
    wind-shift variant and the stress agent's shift_wind disruption.
    """
    model = base_fire[0]["model"]
    p = model["params"]
    if model["id"] != ROTHERMEL_MODEL_ID:
        params = FireParams(p["base_spread_m_per_min"], (p["wind_from_deg"] + shift_deg) % 360, p["wind_speed_m_s"],
                            p["wind_coef_per_m_s"])
        return fixed_fire(ctx.history, params, ctx.end)
    old = ROTHERMEL_CHOSEN_PARAMS
    if p["wind_from_deg"] != old.wind_from_deg:
        raise AssertionError("baseline rothermel-mtt front does not use ROTHERMEL_CHOSEN_PARAMS")
    if ctx.roads_package is None:
        raise VariantUnavailable("a rothermel-mtt baseline needs the roads package to rebuild the front")
    new = replace(old, wind_from_deg=(old.wind_from_deg + shift_deg) % 360)
    block, lookup = rothermel_fire(ctx.history, ctx.roads_package, ctx.end, new,
                                   params_source=f"counterfactual: ROTHERMEL_CHOSEN_PARAMS with wind_from_deg shifted "
                                                 f"{shift_deg:+g} deg; not fitted")
    block["calibration"]["fixed_params"] = True
    block["assumptions"] = [*block["assumptions"],
                            "Counterfactual front: the wind direction is shifted, not fitted; its observation error "
                            "and perimeter IoU are reported but were not used to choose it."]
    return block, lookup


def _wind_shift_rothermel(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    old = ROTHERMEL_CHOSEN_PARAMS
    block, model = shifted_fire(base.fire, ctx, WIND_SHIFT_DEG)
    new = replace(old, wind_from_deg=block["model"]["params"]["wind_from_deg"])
    cal, base_cal = block["calibration"], base.fire[0]["calibration"]

    def err(c: dict, part: str) -> str:
        o = c["observations"][part]
        return f"{o['median_abs_error_min']:.0f} min (n={o['n']}, hit rate {o['hit_rate']:.2f})"

    first = format_utc(ctx.history.perimeters[0].snapshot_at)
    changes = [
        f"Simulated front (rothermel-mtt) wind_from_deg {old.wind_from_deg:g} -> {new.wind_from_deg:g} (30 deg more "
        f"northerly); 20-ft wind {old.wind_20ft_m_s:g} m/s, fuel {old.fuel_model}, moisture '{old.moisture}', "
        f"spotting and seed kept from the baseline; same ignition point, time, terrain and grid. "
        f"{new.wind_from_deg:g} deg is outside the 45-90 deg range the baseline was calibrated over.",
        f"Only the hazard before the first satellite perimeter ({first}) changes; from then on both runs use the "
        "same observed perimeters.",
        f"Median arrival error at NIST observations: calibration window {err(cal, 'train')} vs baseline "
        f"{err(base_cal, 'train')}; held-out window {err(cal, 'held_out')} vs baseline {err(base_cal, 'held_out')}.",
        f"Fit to the first perimeter: IoU {cal['iou']:.2f} (baseline {base_cal['iou']:.2f}).",
    ]
    return replace(base, fire=(block, model)), changes, {}


def _wind_shift(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    if base.fire[0]["model"]["id"] == ROTHERMEL_MODEL_ID:
        return _wind_shift_rothermel(base, ctx)
    p = base.fire[0]["model"]["params"]
    old = FireParams(p["base_spread_m_per_min"], p["wind_from_deg"], p["wind_speed_m_s"], p["wind_coef_per_m_s"])
    new = replace(old, wind_from_deg=(old.wind_from_deg + WIND_SHIFT_DEG) % 360)
    fire = shifted_fire(base.fire, ctx, WIND_SHIFT_DEG)
    first = format_utc(ctx.history.perimeters[0].snapshot_at)
    changes = [
        f"Simulated front wind_from_deg {old.wind_from_deg:g} -> {new.wind_from_deg:g} (30 deg more northerly); "
        f"base spread {old.base_spread_m_per_min:g} m/min, wind {old.wind_speed_m_s:g} m/s and wind coefficient "
        "kept from the calibrated baseline front; same ignition point, time and grid.",
        f"Only the hazard before the first satellite perimeter ({first}) changes; from then on both runs use the "
        "same observed perimeters.",
        f"Fit to the first perimeter: IoU {fire[0]['calibration']['iou']:.2f} "
        f"(baseline {base.fire[0]['calibration']['iou']:.2f}); the shifted front matches the observed extent less well.",
    ]
    return replace(base, fire=fire), changes, {}


def _no_contraflow(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    types = CONTRAFLOW_START_EVENT_TYPES + CONTRAFLOW_END_EVENT_TYPES
    removed = [ev for ev in base.scenario["events"] if ev.type in types]
    if not removed:
        raise VariantUnavailable(
            "the baseline scenario has no contraflow events: NIST road events (sim.events.resolve_road_events) "
            "are not part of the baseline scenario")
    events = [ev for ev in base.scenario["events"] if ev.type not in types]
    changes = [f"Removed {len(removed)} contraflow events: " + ", ".join(ev.id for ev in removed) + "; their derived "
               "inbound-lane closures disappear with them."]
    return _with_events(base, events), changes, {}


def _optimized(base: RunInputs, ctx: Context) -> tuple[RunInputs, list[str], dict]:
    try:
        from sim.optimize import optimize_schedule
    except ImportError as exc:
        raise VariantUnavailable(f"sim.optimize.optimize_schedule is not available: {exc}") from exc
    s = base.scenario
    events, report = optimize_schedule(
        s["network"], s["zones"], s["destinations"], s["events"], base.params, start=ctx.start, end=ctx.end,
        fire_area_at=_fire_area_lookup(ctx.history, base.fire[1][3]), budget_evals=OPTIMIZER_BUDGET_EVALS,
    )
    # Only order times may change: non-order events pass through, and every zone keeps one order.
    def non_orders(evs):
        return sorted((ev for ev in evs if ev.type != "evacuation_order"), key=lambda ev: (ev.at, ev.id))

    if non_orders(events) != non_orders(s["events"]):
        raise AssertionError("optimized: non-order events changed")
    ordered = sorted(z for ev in events if ev.type == "evacuation_order" for z in ev.zone_ids)
    if ordered != sorted(z.id for z in s["zones"]):
        raise AssertionError("optimized: every zone must be ordered exactly once")
    best = report["best"]
    changes = [
        f"Fixture evacuation orders replaced by the best schedule of {report['optimizer']['runs']} simulated "
        f"candidates ({best['id']}: {report.get('method', '')}); every zone is still ordered once, between "
        f"{report['constraints']['earliest_order_at']} and {report['constraints']['latest_order_at']}. "
        "Replacement orders are labelled evidence_class simulated (a plan, not a record).",
        report["limitations"][0],
        report["verdict"],
        *report.get("changes", []),
    ]
    extra = {"optimizer": {k: report[k] for k in ("optimizer", "objective", "constraints", "beats_baseline",
                                                    "improvement", "verdict", "limitations")},
             "schedule": best["schedule"]}
    return _with_events(base, events), changes, extra


VARIANTS = (
    Variant("skyway-closed-0800", "Skyway closed at 08:00",
            "What if the Skyway between Paradise and Chico had been closed in both directions from 08:00 PST?",
            _skyway_closed),
    Variant("all-at-once", "Everyone ordered at once",
            "What if every zone had been ordered to evacuate at the first order time instead of in waves?",
            _all_at_once),
    Variant("slower-response", "Slower response",
            "What if residents had taken twice as long to leave after an order (median delay 60 instead of 30 min)?",
            _slower_response),
    Variant("wind-shift", "Wind 30 degrees more northerly",
            "What if the morning wind had blown from 30 degrees further north (from 37.5 instead of 67.5 deg), "
            "moving the simulated front's path toward the south-west?",
            _wind_shift),
    Variant("no-contraflow", "No contraflow",
            "What if the reported contraflow had not been set up?", _no_contraflow),
    Variant("optimized", "Optimized order schedule",
            "How much could a simulation-optimized order schedule reduce exposure (a hindsight bound)?", _optimized),
)


# --- invariants, runs, comparison


def _fingerprint(items) -> str:
    return hashlib.sha256(json.dumps(items, sort_keys=True, default=str).encode()).hexdigest()[:16]


def basis(inputs: RunInputs, ctx: Context) -> dict:
    """What every variant must share with the baseline."""
    s = inputs.scenario
    p = inputs.params
    return {
        "seed": p.seed,
        "clock": {"start": format_utc(ctx.start), "end": format_utc(ctx.end), "step_s": p.step_s,
                  "record_every_s": p.record_every_s},
        "network": {"edges": len(s["network"].edges), "nodes": len(s["network"].nodes),
                    "sha": _fingerprint([(e.id, e.from_node, e.to_node, e.length_m, e.lanes, e.speed_kph,
                                          e.capacity_veh_per_hour) for e in s["network"].edges])},
        "demand": {"zones": len(s["zones"]), "total_veh": sum(z.vehicles for z in s["zones"]),
                   "sha": _fingerprint([(z.id, z.vehicles, z.origin_nodes) for z in s["zones"]])},
        "destinations_sha": _fingerprint([(d.id, d.node_id, d.capacity_veh) for d in s["destinations"]]),
        "models": {"sim": SIM_VERSION, "traffic": f"{TRAFFIC_MODEL_ID}@{TRAFFIC_MODEL_VERSION}",
                   "fire": f"{inputs.fire[0]['model']['id']}@{inputs.fire[0]['model']['version']}"},
        "fire_ignition": inputs.fire[0]["ignition"],
    }


def _params_diff(a: TrafficParams, b: TrafficParams) -> list[str]:
    da, db = a.to_dict(), b.to_dict()
    return sorted(k for k in da if da[k] != db[k])


def run(inputs: RunInputs, ctx: Context, command: str) -> dict:
    return build_bundle(ctx.history, inputs.scenario, inputs.params, start=ctx.start, end=ctx.end,
                        command=command, fire=inputs.fire)


def check_population(bundle: dict) -> dict:
    total = bundle["traffic"]["summary"]["total_veh"]
    bad = [m["at"] for m in bundle["traffic"]["metrics"]
           if min(m["not_departed_veh"], m["en_route_veh"], m["arrived_veh"]) < 0
           or m["not_departed_veh"] + m["en_route_veh"] + m["arrived_veh"] != total]
    if bad:
        raise AssertionError(f"population not conserved at {bad[:3]}")
    return {"population_conserved": True, "frames_checked": len(bundle["traffic"]["metrics"]), "total_veh": total}


def _delta(base, variant) -> dict:
    return {"baseline": base, "variant": variant,
            "delta": None if base is None or variant is None else round(variant - base, 1)}


def headline_metrics(bundle: dict) -> dict:
    traffic = bundle["traffic"]
    metrics = traffic["metrics"]
    by_at = {m["at"]: m for m in metrics}
    step_min = bundle["clock"]["step_seconds"] / 60
    summary = traffic["summary"]
    return {
        **{f"arrived_by_{at[11:13]}{at[14:16]}z_veh": by_at[at]["arrived_veh"] if at in by_at else None
           for at in COMPARE_ARRIVED_AT},
        "arrived_at_end_veh": summary["arrived_veh"],
        "peak_en_route_veh": summary["max_en_route_veh"],
        "peak_blocked_veh": summary["max_blocked_veh"],
        "peak_exposed_veh": summary["max_exposed_veh"],
        "exposed_veh_min": round(sum(m["exposed_veh"] for m in metrics) * step_min),
        "peak_exposed_at_origin_veh": summary["max_exposed_at_origin_veh"],
        "exposed_at_origin_veh_min": round(sum(m["exposed_at_origin_veh"] for m in metrics) * step_min),
        "total_exposed_veh_min": round(sum(m["exposed_veh"] + m["exposed_at_origin_veh"] for m in metrics) * step_min),
        "blocked_at_end_veh": metrics[-1]["blocked_veh"],
        "clearance_time_s": summary["clearance_time_s"],
    }


def compare(baseline: dict, variant: dict) -> dict:
    b, v = headline_metrics(baseline), headline_metrics(variant)
    base_risk = {z["zone_id"]: z["risk_level"] for z in baseline["insights"]["zones"]}
    changed = [
        {"zone_id": z["zone_id"], "baseline": base_risk.get(z["zone_id"]), "variant": z["risk_level"]}
        for z in variant["insights"]["zones"] if base_risk.get(z["zone_id"]) != z["risk_level"]
    ]

    def levels(zones) -> dict:
        out = {"critical": 0, "high": 0, "elevated": 0, "low": 0}
        for z in zones:
            out[z["risk_level"]] += 1
        return out

    return {
        "evidence_class": "simulated",
        "metrics": {k: _delta(b[k], v[k]) for k in b},
        "clearance_note": "clearance_time_s is null when some vehicles never arrive within the clock window",
        "exposed_veh_min_rule": "sum of exposed_veh (on roads) over frames x frame interval (minutes); "
                                "exposed_at_origin_veh_min likewise for vehicles not yet departed whose origin is "
                                "inside the fire area; total_exposed_veh_min is their sum",
        "zone_risk_changed": changed,
        "zone_risk_counts": {"baseline": levels(baseline["insights"]["zones"]),
                             "variant": levels(variant["insights"]["zones"])},
    }


def variant_document(variant: Variant, changes: list[str], extra: dict, bundle: dict, baseline: dict,
                     inputs: RunInputs, base_inputs: RunInputs, run_basis: dict, population: dict) -> dict:
    doc = {
        "kind": KIND,
        "schema_version": SCHEMA_VERSION,
        "baseline": BASELINE_FILE,
        "generated_by": {"sim_version": SIM_VERSION, "command": bundle["generated_by"]["command"]},
        "variant": {"id": variant.id, "title": variant.title, "question": variant.question, "changes": changes,
                    "evidence_class": "simulated", "details": extra},
        "basis": run_basis,
        "clock": bundle["clock"],
        "traffic": bundle["traffic"],
        "events": bundle["events"],
        "insights": bundle["insights"],
        "comparison": compare(baseline, bundle),
        "checks": population,
        "limitations": COMMON_LIMITATIONS,
    }
    if inputs.fire is not base_inputs.fire:
        doc["fire_simulated"] = bundle["fire_simulated"]
    return doc


def _write(path: Path, payload: dict) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
    path.write_text(text)
    return len(text.encode())


def main() -> None:
    parser = argparse.ArgumentParser(prog="python3 -m sim.variants", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", type=Path, required=True, help="verified incident package directory")
    parser.add_argument("--roads-package", type=Path, required=True, help="verified road package")
    parser.add_argument("--baseline", type=Path, required=True,
                        help="baseline bundle written by `python3 -m sim ... bundle`; must match the in-process baseline")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--only", nargs="+", choices=[v.id for v in VARIANTS], help="run only these variants")
    args = parser.parse_args()
    command = " ".join(["python3 -m sim.variants", *sys.argv[1:]])

    try:
        clock = time.perf_counter()
        history = load_history(args.package)
        scenario, start, end = baseline_inputs(args.roads_package)
        ctx = Context(history, start, end, args.roads_package)
        base = RunInputs(scenario, TrafficParams(), _simulated_fire(history, end, args.roads_package))
        base_basis = basis(base, ctx)
        baseline = run(base, ctx, command)
        on_disk = json.loads(args.baseline.read_text())
        if on_disk["traffic"]["metrics"] != baseline["traffic"]["metrics"] or on_disk["clock"] != baseline["clock"]:
            raise ValueError(f"{args.baseline} differs from the in-process baseline; rebuild it with "
                             "`python3 -m sim ... bundle` or update sim.variants.baseline_inputs to match")
        check_population(baseline)
        print(f"baseline: {time.perf_counter() - clock:.1f} s, matches {args.baseline}")

        entries, skipped = [], []
        for variant in VARIANTS:
            if args.only and variant.id not in args.only:
                continue
            clock = time.perf_counter()
            try:
                inputs, changes, extra = variant.apply(base, ctx)
                run_basis = basis(inputs, ctx)
                if run_basis != base_basis:
                    raise AssertionError(f"{variant.id}: seed, clock, network, demand or models differ from baseline")
                allowed = {"slower-response": ["response_delay_median_min"]}.get(variant.id, [])
                if _params_diff(base.params, inputs.params) != allowed:
                    raise AssertionError(f"{variant.id}: undeclared traffic param changes")
                bundle = run(inputs, ctx, command)
            except VariantUnavailable as exc:
                skipped.append({"id": variant.id, "title": variant.title, "question": variant.question,
                                "reason": str(exc)})
                print(f"{variant.id}: skipped ({exc})")
                continue
            population = check_population(bundle)
            doc = variant_document(variant, changes, extra, bundle, baseline, inputs, base, run_basis, population)
            name = f"{variant.id}.json"
            size = _write(args.output_dir / name, doc)
            runtime = round(time.perf_counter() - clock, 1)
            m = doc["comparison"]["metrics"]
            entries.append({
                "id": variant.id, "title": variant.title, "question": variant.question, "evidence_class": "simulated",
                "file": name, "changes": changes, "runtime_s": runtime, "bytes": size,
                "headline": {k: m[k] for k in ("arrived_by_1800z_veh", "peak_exposed_veh", "total_exposed_veh_min",
                                               "peak_blocked_veh", "clearance_time_s")},
                "zone_risk_changed": len(doc["comparison"]["zone_risk_changed"]),
                "fire_changed": "fire_simulated" in doc,
            })
            print(f"{variant.id}: {runtime} s, {size} bytes")
        # With --only, keep earlier entries for the other variants if they share this basis.
        index_path = args.output_dir / "index.json"
        if args.only and index_path.exists():
            previous = json.loads(index_path.read_text())
            if previous.get("basis") == base_basis:
                ran = {v["id"] for v in entries} | {v["id"] for v in skipped}
                order = [v.id for v in VARIANTS]
                entries = sorted([*entries, *(v for v in previous["variants"] if v["id"] not in ran)],
                                 key=lambda v: order.index(v["id"]))
                skipped = sorted([*skipped, *(v for v in previous["skipped"] if v["id"] not in ran)],
                                 key=lambda v: order.index(v["id"]))
        index = {
            "kind": INDEX_KIND,
            "schema_version": SCHEMA_VERSION,
            "baseline": BASELINE_FILE,
            "generated_by": {"sim_version": SIM_VERSION, "command": command},
            "basis": base_basis,
            "baseline_metrics": headline_metrics(baseline),
            "variants": entries,
            "skipped": skipped,
            "limitations": COMMON_LIMITATIONS,
        }
        _write(index_path, index)
    except (OSError, SourceError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"{args.output_dir}: {len(entries)} variants, {len(skipped)} skipped")


if __name__ == "__main__":
    main()
