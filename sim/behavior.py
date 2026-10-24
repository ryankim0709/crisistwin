"""Resident agent behaviour for the traffic engine: departure decisions and en-route choices.

Each demand packet (a household group of up to `packet_size_veh` vehicles) is an agent with
state waiting -> preparing -> departed. While waiting, it decides to leave with a hazard
(per hour) that sums official notice (order or warning), a fire cue (modelled fire within
`fire_cue_distance_m` of its origin) and a social cue (share of its zone already departed).
After deciding it prepares for a lognormal time, then departs. En route it avoids
fire-exposed edges, may turn back when blocked, and may follow zone-mates (herding).

Parameter values are assumptions informed by wildfire evacuation decision research
(e.g. Kuligowski 2021; McLennan et al. 2019; Lovreglio et al. 2019): official warnings,
environmental cues and neighbours leaving all raise the propensity to leave, a minority
wait for direct cues, and preparation takes tens of minutes. They are not calibrated to
the Camp Fire.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

TRIGGER_ORDER = "order"  # official evacuation order or warning
TRIGGER_FIRE = "fire_cue"
TRIGGER_SOCIAL = "social_cue"
TRIGGERS = (TRIGGER_ORDER, TRIGGER_FIRE, TRIGGER_SOCIAL)

WAITING, PREPARING, DEPARTED = 0, 1, 2


@dataclass(frozen=True)
class BehaviorParams:
    enabled: bool = False  # off for historical replay; True only for agent-based simulation outputs
    decision_every_s: int = 60  # agents re-evaluate departure and turning back at this cadence
    order_hazard_per_h: float = 2.0  # under an order: median decision about 21 min
    warning_hazard_per_h: float = 0.5  # under a warning only: median about 83 min
    fire_cue_hazard_per_h: float = 6.0  # fire seen within fire_cue_distance_m: median about 7 min
    fire_cue_distance_m: float = 2000.0  # "sees smoke or flames" range from the agent's origin node
    social_hazard_per_h: float = 3.0  # at 100% of the zone departed; scales linearly with the departed share
    wait_for_fire_share: float = 0.07  # agents that ignore notices and neighbours until they see fire
    prep_median_min: float = 15.0  # decision -> departure, lognormal median
    prep_sigma: float = 0.6  # lognormal shape
    prep_max_min: float = 120.0  # draws above this are capped
    turn_back_prob: float = 0.5  # chance an agent on a blocked edge turns back (decided once per edge)
    herding_prob: float = 0.3  # share of agents that follow zone-mates' most recent choice at a node
    fire_edge_penalty_s: float = 1800.0  # route cost added to fire-exposed edges that are still open

    def __post_init__(self) -> None:
        if not isinstance(self.decision_every_s, int) or self.decision_every_s <= 0:
            raise ValueError(f"decision_every_s must be a positive integer, got {self.decision_every_s!r}")
        for name in ("order_hazard_per_h", "warning_hazard_per_h", "fire_cue_hazard_per_h", "fire_cue_distance_m",
                     "social_hazard_per_h", "prep_sigma", "fire_edge_penalty_s"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value >= 0):
                raise ValueError(f"{name} must be nonnegative and finite, got {value}")
        for name in ("prep_median_min", "prep_max_min"):
            value = getattr(self, name)
            if not (math.isfinite(value) and value > 0):
                raise ValueError(f"{name} must be positive and finite, got {value}")
        for name in ("wait_for_fire_share", "turn_back_prob", "herding_prob"):
            value = getattr(self, name)
            if not 0 <= value <= 1:
                raise ValueError(f"{name} must be in [0, 1], got {value}")


ASSUMPTIONS = [
    "Residents are agents at household-group (packet) granularity with states waiting, preparing and departed.",
    "A waiting agent decides to leave with hazard = notice + fire cue + social cue (per hour): an order outranks a "
    "warning; the fire cue applies once modelled fire (burned road nodes or the fire boundary) comes within "
    "fire_cue_distance_m of its origin, and stays; the social cue scales with the share of its zone already departed.",
    "A fixed share of agents (wait_for_fire_share) ignores notices and neighbours and leaves only on a fire cue.",
    "The trigger credited for a departure is drawn in proportion to each cue's share of the hazard at decision time.",
    "Preparation time after deciding is lognormal; departure follows preparation.",
    "En route, open fire-exposed edges carry a route-cost penalty; agents on a closed or dead-end edge turn back to "
    "its start node with turn_back_prob (decided once per edge) and re-route to the nearest open exit.",
    "Herding agents take the edge their zone-mates most recently took from a node when it is open and still "
    "reduces travel time to an exit; otherwise they take the fastest route.",
    "Behaviour parameters are informed by wildfire evacuation research (Kuligowski; McLennan et al.; Lovreglio et "
    "al.) but are assumptions, not calibrated to the Camp Fire.",
]
LIMITATIONS = [
    "Agents in a packet decide together; individual vehicles in a household group are not distinguished.",
    "Fire cues are sampled at road nodes and fire boundary vertices, not from smoke visibility or terrain.",
    "No information sharing across zones, no shelter-in-place outcome, and no pickup trips for family members.",
]


def decision_probability(hazard_per_h: float, dt_s: float) -> float:
    """Chance of deciding within dt_s at a constant hazard."""
    return 1.0 - math.exp(-hazard_per_h * dt_s / 3600.0)
