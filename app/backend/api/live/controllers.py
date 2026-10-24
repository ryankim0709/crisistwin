"""Controller plug-ins: observe the situation, compute candidate guidance, hand it to the proposal flow.

``LIVE_CONTROLLER`` selects one: ``rule`` (the livecore planner) or ``twin`` (the planner's
levels, destinations scored with twin what-ifs). Unset means ``twin`` while the twin can be
built, else ``rule``. Either way every number is computed; the LLM only explains it later.
Contract: docs/live-reports.md "Controllers".
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC
from typing import Any, Protocol

from pymongo import UpdateOne
from pymongo.errors import BulkWriteError

from livecore import twinplan
from livecore.inbound import congestion_factors
from livecore.planner import PLANNER_VERSION, ZoneGuidance, plan
from livecore.policy import GuidanceSummary, diff
from livecore.routing import SWITCH_MIN_DWELL_S, SWITCH_MIN_GAIN_FRACTION, SWITCH_MIN_GAIN_S, Incumbent

from . import twin_service
from .common import col, live_setting
from .state import Snapshot, current_guidance

log = logging.getLogger(__name__)

CONTROLLER_IDS = ("rule", "twin")
TWIN_ACTOR = {"kind": "controller", "id": "twin-controller"}
PLAN_CONGESTION_CACHE_S = 10.0
"""Wall seconds the twin's per-edge congestion is reused for an incident at one drill time
(a confirm and the lazy replan right after it plan on the same simulated queues)."""
CONGESTION_UNAVAILABLE = "unavailable"
"""``inputs.congestion`` when the twin is not ready (warming, busy, failed, or LIVE_CONTROLLER=rule
before it was built): the plan uses free-flow edge costs."""
PLAN_ROUTES = "live_plan_routes"
"""Edges of the routes the planner proposed, so published guidance (destination + via) can be
matched to its edges for hysteresis. Never served to clients."""


@dataclass(frozen=True)
class PlanContext:
    """Inputs the planner takes besides the snapshot: simulated congestion and incumbents."""

    congestion: dict[str, float] | None
    """Directed edge id -> travel-time factor (simulated); None when unavailable."""
    label: str
    """``twin@<twin clock ISO>`` or CONGESTION_UNAVAILABLE."""
    incumbents: dict[str, Incumbent] = field(default_factory=dict)

    def inputs(self) -> dict[str, Any]:
        """The proposal ``inputs`` fields that record it."""
        return {
            "congestion": self.label,
            "congestion_evidence_class": "simulated" if self.congestion is not None else None,
            "congested_edges": len(self.congestion or {}),
            "incumbents": len(self.incumbents),
            "incumbents_with_edges": sum(1 for i in self.incumbents.values() if i.edge_ids),
            "hysteresis": {"min_gain_s": SWITCH_MIN_GAIN_S, "min_gain_fraction": SWITCH_MIN_GAIN_FRACTION,
                           "min_dwell_s": SWITCH_MIN_DWELL_S},
        }


_congestion_lock = threading.Lock()
_congestion: dict[str, tuple[float, Any, dict[str, float], str]] = {}


def plan_congestion(snapshot: Snapshot) -> tuple[dict[str, float] | None, str]:
    """``(factors, label)`` from the synced twin at the drill's ``replay_now``: the same factors as
    responder routes (``livecore.inbound.congestion_factors``). ``(None, "unavailable")`` unless
    the twin inputs are already built: planning never waits for the twin to warm."""
    key = snapshot.incident_id
    with _congestion_lock:
        hit = _congestion.get(key)
        if hit is not None and time.monotonic() - hit[0] < PLAN_CONGESTION_CACHE_S and hit[1] == snapshot.clock.replay_now:
            return hit[2], hit[3]
    if twin_service.status(snapshot.incident_id)["status"] != "ready":
        return None, CONGESTION_UNAVAILABLE
    try:
        twin_now, speeds = twin_service.edge_speeds_at(snapshot)
    except twin_service.TwinUnavailable:
        return None, CONGESTION_UNAVAILABLE
    except Exception:  # noqa: BLE001 - a twin failure means free-flow planning, never a failed replan
        log.exception("live controller: reading the twin's edge speeds failed; planning free-flow")
        return None, CONGESTION_UNAVAILABLE
    factors = congestion_factors(speeds, snapshot.index.drill.roads.edges)
    label = f"twin@{twin_now}"
    with _congestion_lock:
        _congestion[key] = (time.monotonic(), snapshot.clock.replay_now, factors, label)
    return factors, label


def _via_key(via: Any) -> str:
    """A scalar key for a route's ``via`` (a unique index over an array would index each name)."""
    return json.dumps([str(v) for v in via or ()], ensure_ascii=False)


def incumbents(snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> dict[str, Incumbent]:
    """Zone id -> the route it follows now: each moving published zone's destination, with the
    edges of the planned route that had the same destination and via (``live_plan_routes``) and
    the drill seconds since its current version was published (``replay_at``; dwell rule)."""
    moving = {z: s for z, s in published.items() if s.level != "none" and not s.no_route and s.destination_id}
    if not moving:
        return {}
    replay_now = snapshot.clock.replay_now
    held: dict[str, float] = {}
    for doc in current_guidance(snapshot.incident_id):
        at = doc.get("replay_at")
        if at is not None and replay_now is not None:
            at = at if at.tzinfo is not None else at.replace(tzinfo=UTC)
            held[doc["zone_id"]] = max(0.0, (replay_now - at).total_seconds())
    docs = col(PLAN_ROUTES).find({"incident_id": snapshot.incident_id, "zone_id": {"$in": sorted(moving)}},
                                 {"_id": 0, "zone_id": 1, "destination_id": 1, "via_key": 1, "edge_ids": 1})
    edges: dict[tuple[str, str, str], tuple[str, ...]] = {
        (d["zone_id"], d["destination_id"], d["via_key"]): tuple(d.get("edge_ids") or ()) for d in docs
    }
    return {
        z: Incumbent(s.destination_id, edges.get((z, s.destination_id, _via_key(s.via))) or None, held.get(z))
        for z, s in sorted(moving.items())
        if s.destination_id is not None
    }


def plan_context(snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> PlanContext:
    factors, label = plan_congestion(snapshot)
    return PlanContext(factors, label, incumbents(snapshot, published))


def remember_routes(incident_id: str, guidance: list[ZoneGuidance], now: Any, replay_at: Any) -> None:
    """Store the edges of every proposed route, keyed by (zone, destination, via)."""
    ops = [
        UpdateOne(
            {"incident_id": incident_id, "zone_id": g.zone_id, "destination_id": g.destination_id,
             "via_key": _via_key(g.route.via)},
            {"$set": {"via": list(g.route.via), "edge_ids": list(g.route.edge_ids), "planned_at": now,
                      "replay_at": replay_at}},
            upsert=True,
        )
        for g in guidance
        if g.route is not None and g.destination_id is not None and not g.no_route and g.level != "none"
    ]
    if not ops:
        return
    try:
        col(PLAN_ROUTES).bulk_write(ops, ordered=False)
    except BulkWriteError:  # a concurrent replan upserted the same key; the memory is best-effort
        log.warning("live controller: some planned routes were not remembered (concurrent replan)")


@dataclass(frozen=True)
class ControllerPlan:
    guidance: list[ZoneGuidance]
    """Every zone, drill order; diffed against published guidance by the proposal flow."""
    controller: dict[str, Any]
    """``{id, version, fallback}``: which controller produced the guidance, and why not the twin."""
    twin: dict[str, Any] | None
    """What-if evidence behind the destinations (TwinController only)."""
    context: PlanContext | None = None
    """Congestion and incumbents the guidance was planned with."""


class Controller(Protocol):
    id: str

    def propose(self, snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> ControllerPlan: ...


class RuleController:
    id = "rule"

    def __init__(self, fallback: str | None = None) -> None:
        self.fallback = fallback

    def propose(self, snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> ControllerPlan:
        ctx = plan_context(snapshot, published)
        guidance = plan(snapshot.index.drill, snapshot.clock.replay_now, snapshot.fire, snapshot.blocked,
                        snapshot.full_destinations, congestion=ctx.congestion, incumbents=ctx.incumbents)
        return ControllerPlan(guidance, {"id": self.id, "version": PLANNER_VERSION, "fallback": self.fallback}, None,
                              ctx)


class TwinController:
    """Planner levels; for zones whose guidance changes and that must move, the destination set
    with the lowest measured what-if cost (``livecore.twinplan``)."""

    id = "twin"

    def propose(self, snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> ControllerPlan:
        base = RuleController().propose(snapshot, published)
        changes = diff(published, base.guidance)
        moving = twinplan.moving_zones(base.guidance, {c.zone_id for c in changes})
        info = {"id": self.id, "version": twinplan.TWIN_CONTROLLER_VERSION, "fallback": None}
        if not moving:
            return ControllerPlan(base.guidance, info, None, base.context)
        if not twin_service.ensure_ready(snapshot.incident_id):
            return self._fallback(base, "twin_warming")
        try:
            return self._score(snapshot, base, moving, info, published)
        except twin_service.TwinUnavailable as exc:
            return self._fallback(base, f"twin_{exc.code}")
        except Exception as exc:  # noqa: BLE001 - never stall guidance on the twin; logged and labeled
            if twin_service.is_twin_error(exc):
                log.warning("live controller: twin rejected the what-if: %s", exc)
                return self._fallback(base, f"twin_error:{getattr(exc, 'code', 'unknown')}")
            log.exception("live controller: twin scoring failed; using the rule planner")
            return self._fallback(base, "twin_failed")

    @staticmethod
    def _fallback(base: ControllerPlan, reason: str) -> ControllerPlan:
        return ControllerPlan(base.guidance, {"id": "rule", "version": PLANNER_VERSION, "fallback": reason}, None,
                              base.context)

    def _score(self, snapshot: Snapshot, base: ControllerPlan, moving: list[ZoneGuidance],
               info: dict[str, Any], published: Mapping[str, GuidanceSummary]) -> ControllerPlan:
        t0 = time.perf_counter()
        drill = snapshot.index.drill
        alts = twinplan.alternatives(drill, moving, snapshot.blocked, snapshot.fire.geometry,
                                     snapshot.full_destinations, base.context.congestion if base.context else None)
        vehicles = {z.id: z.vehicles for z in drill.zones}
        current = {z: summary.destination_id for z, summary in published.items()}
        names = {z.id: z.name for z in drill.zones}
        cands, reference = twinplan.candidates(moving, alts, vehicles, current, names)
        wanted_orders = [
            {"type": "order_zone", "target": {"zone_id": g.zone_id}, "params": {}, "actor": dict(TWIN_ACTOR)}
            for g in moving if g.level == "evacuate_now"
        ]
        orders = twin_service.validate_each(snapshot, wanted_orders) if wanted_orders else []
        sets = [twinplan.action_set(c, orders, TWIN_ACTOR) for c in cands]
        report = twin_service.whatif(snapshot, sets, twinplan.WHATIF_HORIZON_MIN, twinplan.WHATIF_FIRE_AHEAD,
                                     [c.label for c in cands])
        baseline, results = report["results"][0], report["results"][1:]
        choice = twinplan.choose(results, reference, baseline)
        chosen = choice.index
        if chosen is None:
            errors = results[0].get("errors") if results else []
            log.warning("live controller: planner set invalid in the twin: %s", errors)
            return self._fallback(base, "twin_planner_set_invalid")
        guidance = twinplan.apply_choice(base.guidance, cands[chosen], alts)
        twin = {
            "evidence_class": "simulated",
            "from": report["from"],
            "until": report["until"],
            "horizon_min": report["horizon_min"],
            "fire_ahead": report["fire_ahead"],
            "seed": report["seed"],
            "inputs_fingerprint": report["inputs_fingerprint"],
            "action_log_hash": report["action_log_hash"],
            "objective": {"name": "controller_cost_veh_min", "sense": "minimize",
                          "formula": twinplan.cost_formula(), "weights": dict(twinplan.COST_WEIGHTS),
                          "min_gain_veh_min": choice.margin},
            "baseline": {"label": "No new actions", "cost": twinplan.cost(baseline["metrics"]),
                         "metrics": twinplan.metrics_summary(baseline["metrics"])},
            "candidates": [
                {
                    "label": c.label,
                    "destinations": dict(sorted(c.destinations.items())),
                    "valid": r["valid"],
                    "cost": twinplan.cost(r["metrics"]) if r["valid"] else None,
                    "metrics": twinplan.metrics_summary(r["metrics"]) if r["valid"] else None,
                    "errors": r.get("errors") or [],
                }
                for c, r in zip(cands, results)
            ],
            "chosen": chosen,
            "reference": reference,
            "worse_than_baseline": choice.worse_than_baseline,
            "no_signal": choice.no_signal,
            "orders": [o["target"]["zone_id"] for o in orders],
            "runtime_ms": round((time.perf_counter() - t0) * 1000),
            "limitations": report["limitations"],
        }
        return ControllerPlan(guidance, info, twin, base.context)


# ---- selection ----

_announced: str | None = None


def _announce(choice: str, level: int = logging.INFO) -> None:
    global _announced
    if choice != _announced:
        log.log(level, "live controller: %s", choice)
        _announced = choice


def active(incident_id: str | None = None) -> Controller:
    """The controller for this replan (``LIVE_CONTROLLER``; default twin when it builds, else rule)."""
    requested = live_setting("LIVE_CONTROLLER").lower()
    if requested and requested not in CONTROLLER_IDS:
        log.warning("live controller: LIVE_CONTROLLER=%r is not rule|twin; using the default", requested)
        requested = ""
    if requested == "rule":
        _announce("rule (LIVE_CONTROLLER=rule)")
        return RuleController()
    state = twin_service.warm(incident_id)
    if state == "failed":
        _announce(f"rule (twin unavailable: {twin_service.status(incident_id)['error']})", logging.WARNING)
        return RuleController(fallback="twin_failed")
    _announce(f"twin ({'LIVE_CONTROLLER=twin' if requested else 'default'}; inputs {state})")
    return TwinController()


def twin_sentence(twin: dict[str, Any] | None) -> str:
    """One deterministic sentence on the what-if behind the destinations (template rationale).

    States a regression whenever the evidence has one (``worse_than_baseline``): the chosen set
    costing more than no new actions, or leaving more vehicles trapped by fire."""
    if not twin:
        return ""
    chosen = twin["candidates"][twin["chosen"]]
    base = twin["baseline"]
    fire = "fire held at decision time" if twin["fire_ahead"] == "frozen" else "replay fire ahead"
    head = f" Twin check (simulated, {twin['horizon_min']:g} min, {fire}): \"{chosen['label']}\""
    costs = f"cost {chosen['cost']:,.0f} vs {base['cost']:,.0f} veh-min with no new actions"
    trapped, base_trapped = (chosen["metrics"]["trapped_by_fire_at_horizon_veh"],
                             base["metrics"]["trapped_by_fire_at_horizon_veh"])
    if twin.get("worse_than_baseline"):
        if trapped > base_trapped:
            return (f"{head} leaves more vehicles trapped by fire than no new actions "
                    f"({trapped:,.0f} vs {base_trapped:,.0f}); {costs}.")
        return f"{head} is worse than no new actions: {costs}."
    if twin.get("no_signal"):
        if abs(chosen["cost"] - base["cost"]) < twin["objective"]["min_gain_veh_min"]:
            return f"{head}: no measurable difference from no new actions ({costs})."
        return (f"{head}: no measurable difference between the {len(twin['candidates'])} destination sets; "
                f"{costs}.")
    return (
        f"{head} chosen of {len(twin['candidates'])} sets, {costs}; "
        f"{chosen['metrics']['arrived_in_window_veh']:,} vehicles out in the window."
    )


def twin_facts(twin: dict[str, Any] | None) -> dict[str, Any] | None:
    """The twin numbers the LLM may cite (all simulated)."""
    if not twin:
        return None
    chosen = twin["candidates"][twin["chosen"]]
    return {
        "evidence_class": "simulated",
        "window": f"{twin['from']} to {twin['until']}",
        "fire_ahead": twin["fire_ahead"],
        "chosen_set": chosen["label"],
        "sets_compared": len(twin["candidates"]),
        "chosen_cost_veh_min": chosen["cost"],
        "no_new_actions_cost_veh_min": twin["baseline"]["cost"],
        "chosen_metrics": chosen["metrics"],
        "no_new_actions_metrics": twin["baseline"]["metrics"],
        "cost_formula": twin["objective"]["formula"],
        "worse_than_no_new_actions": bool(twin.get("worse_than_baseline")),
        "no_measurable_difference": bool(twin.get("no_signal")),
    }
