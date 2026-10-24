"""Evacuation order schedule optimizer: choose an order time per zone by simulation.

Decision space: a priority rule that ranks zones, plus a wave size and a wave spacing.
Zones are ordered in waves from EARLIEST_ORDER_AT. A structured grid over rules and
wave shapes runs first, then a seeded local search on the best schedule (zone swaps
between waves and wave-shape steps). Every candidate is scored by a full
`simulate_traffic` run with the caller's network, zones, events (other than the
replaced orders), params, horizon and fire lookup. Delay draws depend only on the seed
and zones, so all candidates share the same response delays.

Hindsight: candidates are scored against the modelled fire, which responders did not
have on the day, so the best score is a hindsight bound and not a plan that could have
been chosen in real time. The `ignition_distance` rule uses only distance from the
ignition (known by the first order); it is reported separately as information-feasible.

Run: python3 -m sim.optimize [--budget-evals N] [--output path.json]
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import sys
import time
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from statistics import median

from sim.firefront import CAMP_IGNITION_LONLAT
from sim.history import format_utc, parse_utc
from sim.traffic import (
    DemandZone, Destination, RoadNetwork, TrafficEvent, TrafficParams, _points_inside, simulate_traffic,
)

OPTIMIZER_ID = "order-schedule-search"
OPTIMIZER_VERSION = "0.1.0"
OPTIMIZER_SEED = 11

# First documented evacuation order: CodeRED to Pulga at 07:13 PST, NIST TN 2252 sup. Table D-1.
# No candidate orders earlier, so the optimizer never acts before the historical system did.
EARLIEST_ORDER_AT = datetime.fromisoformat("2018-11-08T15:13:00+00:00")
# Planning bound, not historical: every zone is ordered by this time. It admits the
# fixture baseline, whose last wave is at 17:21Z.
LATEST_ORDER_AT = datetime.fromisoformat("2018-11-08T17:30:00+00:00")
ARRIVALS_REPORTED_BY = datetime.fromisoformat("2018-11-08T18:00:00+00:00")

# Objective, minimised: exposed vehicle-minutes (primary) plus secondary penalties in
# the same unit. A vehicle still blocked at the horizon costs as much as an hour exposed;
# each minute of clearance costs one vehicle-minute. An uncleared run (not every vehicle
# arrived) is charged clearance from EARLIEST_ORDER_AT to the horizon end.
WEIGHT_EXPOSED_VEH_MIN = 1.0
WEIGHT_BLOCKED_AT_END_VEH = 60.0
WEIGHT_CLEARANCE_MIN = 1.0

# Structured grid.
GRID_RULES = ("fire_arrival", "ignition_distance", "exit_time")
GRID_WAVE_SIZES = (1, 3, 6, 12)
GRID_WAVE_SPACINGS_MIN = (2, 4, 8)
DEFAULT_BUDGET_EVALS = 42  # includes the baseline run; about 4-5 s each on the Camp network
# Extra traffic seeds (response-delay draws) on which baseline, best and best information-feasible
# are re-run after the search; not counted in budget_evals and not used for selection.
ROBUSTNESS_SEEDS = (1, 2)
FIRE_ARRIVAL_SAMPLE_S = 300  # cadence for finding when the fire area first reaches a zone

RULES = {
    "fire_arrival": ("hindsight", "earliest modelled fire arrival at any zone origin node first"),
    "ignition_distance": ("information-feasible", "nearest zone centre to the assumed ignition first"),
    "exit_time": ("information-feasible", "longest free-flow time from the zone to its nearest exit first"),
}

LIMITATIONS = [
    "Hindsight bound: candidates are scored against the modelled fire (simulated front, then satellite "
    "perimeters), which real responders did not have; the best schedule is not a feasible real-time plan.",
    "The information-feasible rule (ignition distance) uses no fire forecast, but its wave size and spacing "
    "were still selected by scoring against the modelled fire.",
    "Demand is fixture: a 2 km zone grid with a synthetic 15,000 vehicles; zone order times are not the 2018 orders.",
    "Only order times change. Routing, response delays, road events and fire are identical to the baseline.",
    "Exposure counts vehicles on edges inside the fire area; vehicles stopped on burned edges stay exposed to the "
    "horizon, so stranding early dominates the objective.",
    "Selection uses one traffic seed (one response-delay draw shared by all candidates). The objective is very "
    "sensitive to which few vehicles strand on burned edges, so neighbouring schedules can differ tenfold; see "
    "`robustness` for the chosen schedules on other seeds.",
    "Planning experiment from a simulation; not operational instructions.",
]


def _iso(at: datetime) -> str:
    return format_utc(at)


def _is_replaced_order(ev: TrafficEvent) -> bool:
    """Baseline zone orders the plan replaces: fixture waves or (grounded) derived/historical
    block-group orders. Simulated orders and zone-less timeline events are never replaced."""
    return ev.type == "evacuation_order" and ev.evidence_class != "simulated" and bool(ev.zone_ids)


def schedule_events(base_events, schedule: dict[str, datetime], zone_names: dict[str, str]) -> tuple[TrafficEvent, ...]:
    """Base events with fixture evacuation orders replaced by one simulated-plan order per zone."""
    kept = [ev for ev in base_events if not _is_replaced_order(ev)]
    orders = [
        TrafficEvent(
            id=f"optimized-order-{zone_id}",
            at=at,
            type="evacuation_order",
            label=f"Optimized order (simulated plan): {zone_names.get(zone_id, zone_id)}",
            evidence_class="simulated",
            time_precision="minute",
            zone_ids=(zone_id,),
            source_id=OPTIMIZER_ID,
        )
        for zone_id, at in sorted(schedule.items(), key=lambda kv: (kv[1], kv[0]))
    ]
    return tuple(sorted([*kept, *orders], key=lambda ev: (ev.at, ev.id)))


def _wave_schedule(priority: tuple[str, ...], wave_size: int, spacing_min: int) -> dict[str, datetime]:
    return {z: EARLIEST_ORDER_AT + timedelta(minutes=spacing_min * (rank // wave_size)) for rank, z in enumerate(priority)}


def _violations(schedule: dict[str, datetime], zone_ids: list[str],
                earliest: datetime = EARLIEST_ORDER_AT, latest: datetime = LATEST_ORDER_AT) -> list[str]:
    problems = []
    missing = set(zone_ids) - schedule.keys()
    if missing:
        problems.append(f"{len(missing)} zones never ordered")
    if any(at < earliest for at in schedule.values()):
        problems.append(f"order before {_iso(earliest)}")
    late = max(schedule.values(), default=earliest)
    if late > latest:
        problems.append(f"last order {_iso(late)} after {_iso(latest)}")
    return problems


# --- priority keys -------------------------------------------------------------------

def _zone_centre(zone: DemandZone) -> tuple[float, float]:
    ring = zone.geometry["coordinates"][0] if zone.geometry["type"] == "Polygon" else zone.geometry["coordinates"][0][0]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def _ignition_distance_m(zones) -> dict[str, float]:
    ig_lon, ig_lat = CAMP_IGNITION_LONLAT
    out = {}
    for z in zones:
        lon, lat = _zone_centre(z)
        kx = 111_195.0 * math.cos(math.radians((lat + ig_lat) / 2))
        out[z.id] = math.hypot((lon - ig_lon) * kx, (lat - ig_lat) * 111_195.0)
    return out


def _exit_time_s(network: RoadNetwork, zones, destinations) -> dict[str, float]:
    """Median over a zone's origin nodes of free-flow time to the nearest destination."""
    incoming: dict[str, list[tuple[str, float]]] = {}
    for e in network.edges:
        incoming.setdefault(e.to_node, []).append((e.from_node, e.length_m / (e.speed_kph / 3.6)))
    dist = {d.node_id: 0.0 for d in destinations}
    heap = [(0.0, n) for n in dist]
    heapq.heapify(heap)
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist.get(v, math.inf):
            continue
        for u, cost in incoming.get(v, ()):
            if d + cost < dist.get(u, math.inf):
                dist[u] = d + cost
                heapq.heappush(heap, (d + cost, u))
    return {z.id: median(dist.get(n, math.inf) for n in z.origin_nodes) if z.origin_nodes else math.inf for z in zones}


def _fire_arrival_s(network: RoadNetwork, zones, fire_area_at, start: datetime, end: datetime) -> dict[str, float]:
    """Seconds after start when the fire area first contains any origin node of a zone (inf if never)."""
    points, owner = [], []
    for z in zones:
        for n in z.origin_nodes:
            points.append(network.nodes[n])
            owner.append(z.id)
    arrival = {z.id: math.inf for z in zones}
    remaining = set(range(len(points)))
    last_geom = None
    t = 0
    horizon = (end - start).total_seconds()
    while t <= horizon and remaining:
        geom = fire_area_at(start + timedelta(seconds=t))
        if geom is not None and geom is not last_geom:
            for i in _points_inside(geom, points, sorted(remaining)):
                arrival[owner[i]] = min(arrival[owner[i]], t)
            remaining = {i for i in remaining if arrival[owner[i]] == math.inf}
            last_geom = geom
        t += FIRE_ARRIVAL_SAMPLE_S
    return arrival


# --- evaluation ----------------------------------------------------------------------

def _score(result: dict, params: TrafficParams, end: datetime) -> dict:
    metrics = result["metrics"]
    summary = result["summary"]
    frame_min = params.record_every_s / 60
    exposed_veh_min = sum(m["exposed_veh"] for m in metrics) * frame_min
    blocked_end = metrics[-1]["blocked_veh"] if metrics else 0
    by = _iso(ARRIVALS_REPORTED_BY)
    arrived_by = max((m["arrived_veh"] for m in metrics if m["at"] <= by), default=0)
    clearance_s = summary["clearance_time_s"]
    clearance_min = clearance_s / 60 if clearance_s is not None else (end - EARLIEST_ORDER_AT).total_seconds() / 60
    objective = (WEIGHT_EXPOSED_VEH_MIN * exposed_veh_min + WEIGHT_BLOCKED_AT_END_VEH * blocked_end
                 + WEIGHT_CLEARANCE_MIN * clearance_min)
    return {
        "objective": round(objective, 1),
        "exposed_veh_min": round(exposed_veh_min, 1),
        "peak_exposed_veh": summary["max_exposed_veh"],
        "peak_blocked_veh": summary["max_blocked_veh"],
        "blocked_at_end_veh": blocked_end,
        "arrived_by_report_time_veh": arrived_by,
        "arrived_veh": summary["arrived_veh"],
        "total_veh": summary["total_veh"],
        "clearance_time_s": clearance_s,
    }


def optimize_schedule(
    network: RoadNetwork,
    zones: tuple[DemandZone, ...] | list[DemandZone],
    destinations: tuple[Destination, ...] | list[Destination],
    base_events: tuple[TrafficEvent, ...] | list[TrafficEvent],
    params: TrafficParams,
    *,
    start: datetime,
    end: datetime,
    fire_area_at: Callable[[datetime], dict | None],
    budget_evals: int = DEFAULT_BUDGET_EVALS,
    seed: int = OPTIMIZER_SEED,
) -> tuple[tuple[TrafficEvent, ...], dict]:
    """Search order schedules; return (events of the best schedule, report).

    `base_events` is the baseline scenario's event list. Its fixture `evacuation_order`
    events are the baseline schedule and are replaced in every candidate; all other
    events pass through unchanged. `fire_area_at` should be built once by the caller
    (as `sim.bundle` does) and is reused for every run. `budget_evals` counts simulation
    runs, the baseline included. The returned events are the baseline events again if no
    candidate beats the baseline (`report["beats_baseline"]` is then False).
    """
    if budget_evals < 2:
        raise ValueError("budget_evals must allow the baseline and at least one candidate")
    zone_list = list(zones)
    zone_ids = [z.id for z in zone_list]
    zone_names = {z.id: z.name for z in zone_list}
    baseline_orders = [ev for ev in base_events if _is_replaced_order(ev)]
    if not baseline_orders:
        raise ValueError("base_events has no zone evacuation_order events to replace")
    baseline_schedule: dict[str, datetime] = {}
    for ev in sorted(baseline_orders, key=lambda ev: ev.at):
        for z in ev.zone_ids:
            baseline_schedule.setdefault(z, ev.at)
    clock = time.perf_counter()

    evaluated: dict[tuple, dict] = {}  # schedule signature -> candidate record
    candidates: list[dict] = []
    rejected: list[dict] = []
    runs = 0

    def signature(schedule: dict[str, datetime]) -> tuple:
        return tuple(sorted((z, at.isoformat()) for z, at in schedule.items()))

    # Bounds never stricter than history: a historical baseline order before EARLIEST_ORDER_AT
    # or after LATEST_ORDER_AT widens them (the baseline itself is history, not a candidate).
    earliest = min(EARLIEST_ORDER_AT, *baseline_schedule.values())
    latest = max(LATEST_ORDER_AT, *baseline_schedule.values())

    def evaluate(cid: str, schedule: dict[str, datetime], spec: dict, events=None) -> dict | None:
        nonlocal runs
        problems = _violations(schedule, zone_ids, earliest, latest)
        if problems:
            rejected.append({"id": cid, **spec, "reasons": problems})
            return None
        sig = signature(schedule)
        if sig in evaluated:
            return evaluated[sig]
        if runs >= budget_evals:
            return None
        t = time.perf_counter()
        result = simulate_traffic(network, zone_list, destinations,
                                  events if events is not None else schedule_events(base_events, schedule, zone_names),
                                  params, start=start, end=end, fire_area_at=fire_area_at)
        runs += 1
        record = {"id": cid, **spec, "last_order_at": _iso(max(schedule.values())),
                  "metrics": _score(result, params, end), "runtime_s": round(time.perf_counter() - t, 2)}
        record["_schedule"] = schedule
        evaluated[sig] = record
        candidates.append(record)
        return record

    baseline = evaluate("baseline", baseline_schedule,
                        {"rule": "baseline", "information": "baseline schedule", "wave_size": None,
                         "wave_spacing_min": None},
                        events=tuple(base_events))
    if baseline is None:
        raise ValueError(f"baseline schedule violates the constraints: {rejected[-1]['reasons']}")

    keys = {
        "fire_arrival": _fire_arrival_s(network, zone_list, fire_area_at, start, end),
        "ignition_distance": _ignition_distance_m(zone_list),
        "exit_time": {z: -s for z, s in _exit_time_s(network, zone_list, destinations).items()},
    }
    tiebreak = keys["ignition_distance"]
    priorities = {rule: tuple(sorted(zone_ids, key=lambda z: (keys[rule][z], tiebreak[z], z))) for rule in GRID_RULES}

    def spec_of(rule: str, size: int, spacing: int, information: str | None = None) -> dict:
        return {"rule": rule, "information": information or RULES[rule][0], "wave_size": size, "wave_spacing_min": spacing}

    evaluate("all-at-first-order", {z: EARLIEST_ORDER_AT for z in zone_ids},
                        spec_of("ignition_distance", len(zone_ids), 0))
    for rule in GRID_RULES:
        for size in GRID_WAVE_SIZES:
            for spacing in GRID_WAVE_SPACINGS_MIN:
                evaluate(f"{rule}-w{size}-s{spacing}", _wave_schedule(priorities[rule], size, spacing),
                         spec_of(rule, size, spacing))

    # Seeded local search from the best grid schedule: swap zones between waves or step the wave shape.
    rng = random.Random(seed)
    best = min(candidates, key=lambda c: c["metrics"]["objective"])
    if best is not baseline and best["wave_size"]:
        current = (priorities[best["rule"]], best["wave_size"], best["wave_spacing_min"])
        current_score = best["metrics"]["objective"]
        attempts = 0
        while runs < budget_evals and attempts < budget_evals * 5:
            attempts += 1
            order, size, spacing = current
            if rng.random() < 0.7 and size < len(order):
                i = rng.randrange(size, len(order))
                j = rng.randrange(max(0, (i // size - 1) * size), (i // size) * size)  # a zone in the previous wave
                swapped = list(order)
                swapped[i], swapped[j] = swapped[j], swapped[i]
                move = (tuple(swapped), size, spacing)
            else:
                move = (order, max(1, size + rng.choice((-1, 1))), max(1, spacing + rng.choice((-1, 1))))
            schedule = _wave_schedule(*move)
            if signature(schedule) in evaluated or _violations(schedule, zone_ids):
                continue
            record = evaluate(f"local-{runs}", schedule, spec_of(best["rule"], move[1], move[2], "hindsight")
                              | {"rule": f"{best['rule']}+local-search"})
            if record and record["metrics"]["objective"] < current_score:
                current, current_score = move, record["metrics"]["objective"]

    best = min(candidates, key=lambda c: c["metrics"]["objective"])
    feasible = [c for c in candidates if c["information"] == "information-feasible" and c["rule"] == "ignition_distance"]
    best_feasible = min(feasible, key=lambda c: c["metrics"]["objective"]) if feasible else None
    beats = best["metrics"]["objective"] < baseline["metrics"]["objective"]
    events = schedule_events(base_events, best["_schedule"], zone_names) if beats else tuple(base_events)
    search_runtime_s = round(time.perf_counter() - clock, 1)

    robustness = []
    for extra_seed in ROBUSTNESS_SEEDS:
        seeded = replace(params, seed=extra_seed)
        row = {"seed": extra_seed}
        for name, c in (("baseline", baseline), ("best", best), ("best_information_feasible", best_feasible)):
            if c is None:
                continue
            run_events = tuple(base_events) if c is baseline else schedule_events(base_events, c["_schedule"], zone_names)
            result = simulate_traffic(network, zone_list, destinations, run_events, seeded,
                                      start=start, end=end, fire_area_at=fire_area_at)
            row[name] = _score(result, seeded, end)
        robustness.append(row)

    changes = [
        f"{zone_names.get(z, z)} ({z}) order {baseline_schedule[z].strftime('%H:%MZ')} -> {at.strftime('%H:%MZ')}"
        for z, at in sorted(best["_schedule"].items(), key=lambda kv: (kv[1], kv[0]))
        if beats and at != baseline_schedule.get(z)
    ]

    def schedule_out(c: dict) -> list[dict]:
        return [{"zone_id": z, "order_at": _iso(at)} for z, at in sorted(c["_schedule"].items(), key=lambda kv: (kv[1], kv[0]))]

    def public(c: dict | None) -> dict | None:
        return None if c is None else {k: v for k, v in c.items() if not k.startswith("_")}

    base_obj = baseline["metrics"]["objective"]
    report = {
        "kind": "evacuation_order_optimization",
        "evidence_class": "simulated",
        "optimizer": {"id": OPTIMIZER_ID, "version": OPTIMIZER_VERSION, "seed": seed, "budget_evals": budget_evals,
                      "runs": runs, "search_runtime_s": search_runtime_s,
                      "runtime_s": round(time.perf_counter() - clock, 1)},
        "method": (f"{OPTIMIZER_ID} {OPTIMIZER_VERSION}: structured grid over priority rule x wave size x wave spacing, "
                   f"then seeded local search; {runs} simulate_traffic runs scored against the modelled fire "
                   "(hindsight bound)"),
        "changes": changes,
        "traffic_params": params.to_dict(),
        "clock": {"start": _iso(start), "end": _iso(end), "frame_interval_s": params.record_every_s},
        "objective": {
            "minimise": "w_exposed * exposed_veh_min + w_blocked_end * blocked_at_end_veh + w_clearance * clearance_min",
            "exposed_veh_min": "sum of exposed_veh over recorded frames x frame interval (min)",
            "clearance_min": "clearance_time_s / 60, or minutes from the earliest order to the horizon end if not every "
                             "vehicle arrived",
            "weights": {"w_exposed": WEIGHT_EXPOSED_VEH_MIN, "w_blocked_end": WEIGHT_BLOCKED_AT_END_VEH,
                        "w_clearance": WEIGHT_CLEARANCE_MIN},
            "arrivals_reported_by": _iso(ARRIVALS_REPORTED_BY),
        },
        "constraints": {
            "earliest_order_at": _iso(EARLIEST_ORDER_AT),
            "earliest_order_source": "first CodeRED evacuation order (Pulga, 07:13 PST), NIST TN 2252 sup. Table D-1",
            "latest_order_at": _iso(LATEST_ORDER_AT),
            "latest_order_basis": "planning bound, not historical; admits the fixture baseline",
            "every_zone_ordered_once": True,
            "unchanged": "network, zones, destinations, non-order events, traffic params (incl. response-delay model "
                         "and seed), horizon and fire lookup are identical for every candidate",
        },
        "decision_space": {
            "rules": {rule: {"information": info, "description": desc} for rule, (info, desc) in RULES.items()},
            "wave_sizes": list(GRID_WAVE_SIZES), "wave_spacings_min": list(GRID_WAVE_SPACINGS_MIN),
            "also": ["all zones at the earliest order time", "seeded local search: swap zones between adjacent waves, "
                     "step wave size or spacing by 1"],
        },
        "baseline": public(baseline),
        "best": public(best) | {"schedule": schedule_out(best)},
        "best_information_feasible": None if best_feasible is None else public(best_feasible) | {"schedule": schedule_out(best_feasible)},
        "beats_baseline": beats,
        "improvement": {
            "objective_pct": round(100 * (base_obj - best["metrics"]["objective"]) / base_obj, 1) if base_obj else None,
            "exposed_veh_min_pct": round(100 * (baseline["metrics"]["exposed_veh_min"] - best["metrics"]["exposed_veh_min"])
                                         / baseline["metrics"]["exposed_veh_min"], 1)
            if baseline["metrics"]["exposed_veh_min"] else None,
        },
        "verdict": (f"Best schedule ({best['id']}) beats the baseline under identical settings."
                    if beats else "No candidate beat the baseline; the returned events are the baseline events."),
        "robustness": {"seeds": list(ROBUSTNESS_SEEDS), "note": "same schedules re-run with other response-delay "
                       "draws; not used for selection", "runs": robustness},
        "candidates": [public(c) for c in candidates],
        "rejected": rejected,
        "limitations": LIMITATIONS,
    }
    return events, report


def main() -> None:
    from sim.bundle import _fire_area_lookup, _simulated_fire
    from sim.history import load_history
    from sim.network import load_alert_events, load_road_network
    from sim.scenario import hybrid_scenario

    parser = argparse.ArgumentParser(prog="python3 -m sim.optimize", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", type=Path, default=Path("data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65"))
    parser.add_argument("--roads-package", type=Path, default=Path("data/incidents/camp-2018-evacuation/b1b318c16bbd3270"))
    parser.add_argument("--start", default="2018-11-08T14:00:00Z")
    parser.add_argument("--end", default="2018-11-09T08:00:00Z")
    parser.add_argument("--budget-evals", type=int, default=DEFAULT_BUDGET_EVALS)
    parser.add_argument("--seed", type=int, default=OPTIMIZER_SEED)
    parser.add_argument("--output", type=Path, help="write the report as JSON")
    args = parser.parse_args()

    history = load_history(args.package)
    network, exits, provenance = load_road_network(args.roads_package)
    scenario = hybrid_scenario(network, exits, provenance["assumptions"])
    base_events = (*scenario["events"], *load_alert_events(args.roads_package))
    start, end = parse_utc(args.start), parse_utc(args.end)
    _, fire_model = _simulated_fire(history, end, args.roads_package)
    fire_area_at = _fire_area_lookup(history, fire_model[3])
    _, report = optimize_schedule(network, scenario["zones"], exits, base_events, TrafficParams(),
                                  start=start, end=end, fire_area_at=fire_area_at,
                                  budget_evals=args.budget_evals, seed=args.seed)

    cols = ("objective", "exposed_veh_min", "peak_exposed_veh", "peak_blocked_veh", "blocked_at_end_veh",
            "arrived_by_report_time_veh", "clearance_time_s")
    print(f"{'candidate':34} {'info':22} " + " ".join(f"{c[:14]:>14}" for c in cols))
    for c in sorted(report["candidates"], key=lambda c: c["metrics"]["objective"]):
        print(f"{c['id']:34} {c['information']:22} " + " ".join(f"{str(c['metrics'][k]):>14}" for k in cols))
    print(f"rejected: {len(report['rejected'])}; runs: {report['optimizer']['runs']}; "
          f"search {report['optimizer']['search_runtime_s']} s, total {report['optimizer']['runtime_s']} s")
    for row in report["robustness"]["runs"]:
        print(f"seed {row['seed']}: " + "; ".join(f"{k} {v['exposed_veh_min']} veh-min, blocked end "
                                                  f"{v['blocked_at_end_veh']}" for k, v in row.items() if k != "seed"))
    print(report["verdict"], json.dumps(report["improvement"]))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, sort_keys=True, indent=1, allow_nan=False) + "\n")
        print(f"wrote {args.output}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        sys.exit(f"error: {exc}")
