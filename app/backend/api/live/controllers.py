"""Controller plug-ins: observe the situation, compute candidate guidance, hand it to the proposal flow.

``LIVE_CONTROLLER`` selects one: ``rule`` (the livecore planner) or ``twin`` (the planner's
levels, destinations scored with twin what-ifs). Unset means ``twin`` while the twin can be
built, else ``rule``. Either way every number is computed; the LLM only explains it later.
Contract: docs/live-reports.md "Controllers".
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from livecore import twinplan
from livecore.planner import PLANNER_VERSION, ZoneGuidance, plan
from livecore.policy import GuidanceSummary, diff

from . import twin_service
from .common import live_setting
from .state import Snapshot

log = logging.getLogger(__name__)

CONTROLLER_IDS = ("rule", "twin")
TWIN_ACTOR = {"kind": "controller", "id": "twin-controller"}


@dataclass(frozen=True)
class ControllerPlan:
    guidance: list[ZoneGuidance]
    """Every zone, drill order; diffed against published guidance by the proposal flow."""
    controller: dict[str, Any]
    """``{id, version, fallback}``: which controller produced the guidance, and why not the twin."""
    twin: dict[str, Any] | None
    """What-if evidence behind the destinations (TwinController only)."""


class Controller(Protocol):
    id: str

    def propose(self, snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> ControllerPlan: ...


class RuleController:
    id = "rule"

    def __init__(self, fallback: str | None = None) -> None:
        self.fallback = fallback

    def propose(self, snapshot: Snapshot, published: Mapping[str, GuidanceSummary]) -> ControllerPlan:
        guidance = plan(snapshot.index.drill, snapshot.clock.replay_now, snapshot.fire, snapshot.blocked,
                        snapshot.full_destinations)
        return ControllerPlan(guidance, {"id": self.id, "version": PLANNER_VERSION, "fallback": self.fallback}, None)


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
            return ControllerPlan(base.guidance, info, None)
        if not twin_service.ensure_ready():
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
        return ControllerPlan(base.guidance, {"id": "rule", "version": PLANNER_VERSION, "fallback": reason}, None)

    def _score(self, snapshot: Snapshot, base: ControllerPlan, moving: list[ZoneGuidance],
               info: dict[str, Any], published: Mapping[str, GuidanceSummary]) -> ControllerPlan:
        t0 = time.perf_counter()
        drill = snapshot.index.drill
        alts = twinplan.alternatives(drill, moving, snapshot.blocked, snapshot.fire.geometry,
                                     snapshot.full_destinations)
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
        return ControllerPlan(guidance, info, twin)


# ---- selection ----

_announced: str | None = None


def _announce(choice: str, level: int = logging.INFO) -> None:
    global _announced
    if choice != _announced:
        log.log(level, "live controller: %s", choice)
        _announced = choice


def active() -> Controller:
    """The controller for this replan (``LIVE_CONTROLLER``; default twin when it builds, else rule)."""
    requested = live_setting("LIVE_CONTROLLER").lower()
    if requested and requested not in CONTROLLER_IDS:
        log.warning("live controller: LIVE_CONTROLLER=%r is not rule|twin; using the default", requested)
        requested = ""
    if requested == "rule":
        _announce("rule (LIVE_CONTROLLER=rule)")
        return RuleController()
    state = twin_service.warm()
    if state == "failed":
        _announce(f"rule (twin unavailable: {twin_service.status()['error']})", logging.WARNING)
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
