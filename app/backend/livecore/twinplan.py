"""Twin-scored destination choice for the TwinController (pure; no Django, no sim import).

The rule planner fixes every level. For zones whose guidance changes and that must move,
this module builds a few destination alternatives (the planner's route, then the next
nearest usable destinations), turns them into twin what-if action sets, and picks the set
with the lowest controller cost from the measured what-if metrics. The reference set (the
current destinations when still usable, else the planner's) wins unless another set is
better by a clear margin, or the reference is worse than taking no new actions and another
set is not. The choice records whether it is still worse than no new actions and whether the
twin measured any difference at all (``Choice``).

Contract: docs/live-reports.md "Controllers" and docs/twin-api.md "HTTP adapter".
"""

from __future__ import annotations

import dataclasses
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .drill import Drill
from .geo import MultiPolygon
from .planner import ZoneGuidance
from .routing import Route, best_routes

TWIN_CONTROLLER_VERSION = "twin-controller-v1"
ALTERNATIVE_ROUNDS = 3
"""Destinations tried per zone: the planner's plus up to two next-nearest usable ones."""
MAX_SWAP_SETS = 4
"""Single-zone swaps scored, for the zones with the most vehicles."""
WHATIF_HORIZON_MIN = 60
WHATIF_FIRE_AHEAD = "frozen"
"""Information-feasible: the fire area is held at the decision time. ``replay`` would use the
replay's future fire (hindsight), which a real controller does not have."""

# Controller cost (vehicle-minutes; planning heuristic, not calibrated). See docs/twin-api.md.
COST_WEIGHT_EXPOSED_VEH_MIN = 1.0
"""``total_exposed_veh_min``: vehicles on fire-exposed edges or waiting at origins inside the fire area."""
COST_WEIGHT_BLOCKED_AT_HORIZON_VEH = 15.0
"""Single-frame count; 15 min is three reroute intervals (``reroute_interval_s`` 300 s), the
expected wait before a blocked vehicle is rerouted. The twin default (60) lets one or two
5-vehicle packets of noise outweigh about 1,000 measured exposure veh-min."""
COST_WEIGHT_TRAPPED_AT_HORIZON_VEH = 60.0
"""Vehicles trapped by fire at the horizon: the worst outcome, charged one full horizon."""
COST_WEIGHT_REMAINING_AT_HORIZON_VEH = 1.0
"""Vehicles not yet arrived at the horizon: one minute each, so throughput breaks ties."""
MIN_GAIN_VEH_MIN = 250.0
MIN_GAIN_FRACTION = 0.0025
"""An alternative replaces the planner's set only when it lowers the cost by at least
max(MIN_GAIN_VEH_MIN, MIN_GAIN_FRACTION x planner cost): one seed, small differences are noise."""

COST_WEIGHTS: dict[str, float] = {
    "total_exposed_veh_min": COST_WEIGHT_EXPOSED_VEH_MIN,
    "blocked_at_horizon_veh": COST_WEIGHT_BLOCKED_AT_HORIZON_VEH,
    "trapped_by_fire_at_horizon_veh": COST_WEIGHT_TRAPPED_AT_HORIZON_VEH,
    "remaining_at_horizon_veh": COST_WEIGHT_REMAINING_AT_HORIZON_VEH,
}
SUMMARY_METRICS = (
    "arrived_in_window_veh",
    "total_exposed_veh_min",
    "blocked_at_horizon_veh",
    "trapped_by_fire_at_horizon_veh",
    "remaining_at_horizon_veh",
)


@dataclass(frozen=True)
class Choice:
    """Outcome of ``choose``."""

    index: int | None
    """Chosen candidate (candidate order); None when no usable set is valid."""
    margin: float | None
    """Cost gain (veh-min) an alternative needed over the reference."""
    worse_than_baseline: bool = False
    """The chosen set costs more than no new actions, or leaves more vehicles trapped by fire."""
    no_signal: bool = False
    """Every valid set costs the same, or the chosen set is within ``margin`` of no new actions."""


@dataclass(frozen=True)
class Candidate:
    """One what-if action set: a destination per moving zone (plus the shared orders)."""

    label: str
    destinations: dict[str, str]
    """Zone id -> destination id for every zone that moves."""


def cost(metrics: Mapping[str, Any]) -> float:
    return round(sum(w * float(metrics[k]) for k, w in COST_WEIGHTS.items()), 1)


def cost_formula() -> str:
    return " + ".join(f"{w:g}*{k}" for k, w in COST_WEIGHTS.items())


def moving_zones(guidance: Sequence[ZoneGuidance], zone_ids: Collection[str]) -> list[ZoneGuidance]:
    """Planner results for ``zone_ids`` that tell people to move along a route."""
    wanted = set(zone_ids)
    return [g for g in guidance if g.zone_id in wanted and g.level != "none" and not g.no_route and g.route]


def alternatives(
    drill: Drill,
    moving: Sequence[ZoneGuidance],
    blocked_segment_ids: Collection[str],
    avoid_polygon: MultiPolygon | None,
    full_destination_ids: Collection[str],
) -> dict[str, list[Route]]:
    """Zone id -> routes to distinct destinations, the planner's first.

    Round n reruns ``best_routes`` with every destination chosen in earlier rounds for these
    zones treated as unavailable, so each zone gets its next-nearest usable destination.
    """
    out: dict[str, list[Route]] = {g.zone_id: [g.route] for g in moving if g.route is not None}
    excluded = set(full_destination_ids)
    for _ in range(ALTERNATIVE_ROUNDS - 1):
        excluded |= {r.destination_id for routes in out.values() for r in routes}
        routes = best_routes(drill, blocked_segment_ids, avoid_polygon, excluded)
        for zone_id, have in out.items():
            r = routes.get(zone_id)
            if r is not None and all(r.destination_id != h.destination_id for h in have):
                have.append(r)
    return out


def candidates(moving: Sequence[ZoneGuidance], alts: Mapping[str, Sequence[Route]], vehicles: Mapping[str, int],
               published: Mapping[str, str | None], names: Mapping[str, str]) -> tuple[list[Candidate], int]:
    """Candidate sets and the index of the reference set.

    Sets: the planner's; "Keep current destinations" when a zone's published destination is
    still one of its usable alternatives (so guidance does not flip on small differences);
    single-zone swaps to the second choice for the biggest ordered (``evacuate_now``) zones; all
    ordered zones to their second choice. Zones that are not ordered get no swap sets: nobody
    departs from them in the what-if, so their destination cannot change the result. The
    reference is "Keep current destinations" when present, else the planner's.
    """
    planner = {g.zone_id: alts[g.zone_id][0].destination_id for g in moving if g.zone_id in alts}
    out = [Candidate("Planner routes", planner)]
    reference = 0
    keep = {
        z: published[z] for z, dest in planner.items()
        if published.get(z) not in (None, dest) and any(r.destination_id == published[z] for r in alts[z])
    }
    if keep:
        out.append(Candidate("Keep current destinations", {**planner, **keep}))
        reference = 1
    ordered = {g.zone_id for g in moving if g.level == "evacuate_now"}
    swappable = [z for z in planner if z in ordered and len(alts[z]) > 1]
    swappable.sort(key=lambda z: (-vehicles.get(z, 0), z))
    for z in swappable[:MAX_SWAP_SETS]:
        out.append(Candidate(f"{names.get(z, z)} to second choice", {**planner, z: alts[z][1].destination_id}))
    if len(swappable) > 1:
        out.append(Candidate("All to second choice", {**planner, **{z: alts[z][1].destination_id for z in swappable}}))
    return out, reference


def action_set(candidate: Candidate, orders: Sequence[dict[str, Any]], actor: Mapping[str, str]) -> list[dict[str, Any]]:
    """Twin actions: the shared orders, then one ``reroute_zone`` per destination."""
    by_dest: dict[str, list[str]] = {}
    for zone_id, dest in sorted(candidate.destinations.items()):
        by_dest.setdefault(dest, []).append(zone_id)
    reroutes = [
        {"type": "reroute_zone", "target": {"zone_ids": zones}, "params": {"destination_id": dest}, "actor": dict(actor)}
        for dest, zones in sorted(by_dest.items())
    ]
    return [dict(o) for o in orders] + reroutes


def _worse(r: Mapping[str, Any], baseline: Mapping[str, Any]) -> bool:
    m, b = r["metrics"], baseline["metrics"]
    return cost(m) > cost(b) or float(m["trapped_by_fire_at_horizon_veh"]) > float(b["trapped_by_fire_at_horizon_veh"])


def choose(results: Sequence[Mapping[str, Any]], reference: int = 0,
           baseline: Mapping[str, Any] | None = None) -> Choice:
    """The chosen set (index into ``results``, candidate order) and how it compares with no new actions.

    ``results[i]`` is the what-if result for candidate i (``valid``, ``metrics``); ``baseline`` the
    no-new-actions result. The reference set is kept unless another valid set is cheaper by the
    margin. Falls back to the planner's set (0) when the reference is invalid; ``index`` None when
    that is invalid too. When the pick is worse than the baseline (``_worse``) and some valid set
    is not, the cheapest such set is chosen instead: avoiding a measured regression outranks
    keeping destinations stable.
    """
    if not results:
        return Choice(None, None)
    if not results[reference].get("valid"):
        if reference == 0 or not results[0].get("valid"):
            return Choice(None, None)
        reference = 0
    base = cost(results[reference]["metrics"])
    margin = max(MIN_GAIN_VEH_MIN, MIN_GAIN_FRACTION * abs(base))
    best, best_cost = reference, base
    valid = [(i, r) for i, r in enumerate(results) if r.get("valid")]
    for i, r in valid:
        if i != reference:
            c = cost(r["metrics"])
            if c <= base - margin and c < best_cost:
                best, best_cost = i, c
    worse = baseline is not None and baseline.get("valid", True) and _worse(results[best], baseline)
    if worse:
        better = [(cost(r["metrics"]), i) for i, r in valid if not _worse(r, baseline)]
        if better:
            best, worse = min(better)[1], False
    costs = {cost(r["metrics"]) for _, r in valid}
    tie = len(valid) > 1 and len(costs) == 1
    close = (baseline is not None and baseline.get("valid", True)
             and abs(cost(results[best]["metrics"]) - cost(baseline["metrics"])) < margin)
    return Choice(best, round(margin, 1), bool(worse), bool(tie or close))


def apply_choice(guidance: Sequence[ZoneGuidance], candidate: Candidate,
                 alts: Mapping[str, Sequence[Route]]) -> list[ZoneGuidance]:
    """The planner's guidance with each moving zone sent to the candidate's destination."""
    out = []
    for g in guidance:
        dest = candidate.destinations.get(g.zone_id)
        if dest is not None and dest != g.destination_id:
            route = next((r for r in alts.get(g.zone_id, ()) if r.destination_id == dest), None)
            if route is not None:
                g = dataclasses.replace(g, destination_id=dest, route=route)
        out.append(g)
    return out


def metrics_summary(metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {k: metrics[k] for k in SUMMARY_METRICS}
