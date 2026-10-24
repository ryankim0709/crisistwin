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
from dataclasses import dataclass, replace

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
    "TrafficParams.response_delay_median_min scales agent response time: hazards are divided and preparation "
    "multiplied by response_delay_median_min / 30 (values here are stated at 30 min).",
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


# ---- People behaviour from sourced data (tools/people_behavior.json, docs/people-data.md), for the fixed-delay
# twin that the live drill and the batch runner use. Off by default, so historical Camp replays are unchanged; a
# scenario spec turns it on (`twin.people`, docs/live-scenario-runner.md).

ORDER_COMPLIANCE_RANGE = (0.870, 0.968)
"""SOURCED: share of mandatory-order recipients who evacuated, Wong, Broader and Shaheen (2020), Table 11 p. 39
(Dec 2017 S. California 0.870, Oct 2017 N. California 0.875, Carr 2018 0.968); people_behavior.json
`order_compliance`."""
ORDER_COMPLIANCE_OCT2017_NORCAL = 0.875
"""SOURCED (same table): the Oct 2017 Northern California fires (Tubbs, Nuns, Atlas), the fast, low-notice,
wind-driven fires of that sample, taken as the closest analogue of Camp (the choice of analogue is ours)."""
SHADOW_EVACUATION_RANGE = (0.291, 0.750)
"""SOURCED: share of households with no mandatory order that evacuated anyway, Wong et al. (2020) Table 11 p. 39
(Oct 2017 N. California 0.291, Dec 2017 S. California 0.625, Carr 2018 0.750); people_behavior.json
`shadow_evacuation_share`."""
SHADOW_EVACUATION_OCT2017_NORCAL = 0.291
"""SOURCED (same table, same analogue). people_behavior.json suggests 0.30 (an assumption at the same low end)."""
CAMP_AWARENESS_TO_DEPARTURE_MEAN_MIN = 93.0
"""DERIVED (people_behavior.json `camp_awareness_departure_timing`): Grajdura (2022) pp. 51-52, mean departure
09:33 minus mean awareness 08:00 local, Camp Fire survey n=397 (a difference of two sample means)."""
DEPARTURE_DELAY_SIGMA = 0.8
"""ASSUMPTION reused from sim.traffic.TrafficParams.response_delay_sigma (the source gives a mean, not a shape)."""
CAMP_DEPARTURE_DELAY_MEDIAN_MIN = round(CAMP_AWARENESS_TO_DEPARTURE_MEAN_MIN / math.exp(DEPARTURE_DELAY_SIGMA ** 2 / 2), 1)
"""DERIVED: median of a lognormal with that mean and shape, 93 / exp(0.8^2 / 2) = 67.5 min. Applied from the order
(or, for shadow evacuees, from the fire cue): Camp residents mostly learned of the fire from cues, not notices
(people_behavior.json `camp_order_receipt`), so this puts the awareness-to-departure gap on the twin's clock."""


@dataclass(frozen=True)
class PeopleBehavior:
    """Behaviour realism for the twin's demand (fixed-delay engine). Defaults reproduce the historical replay."""

    order_compliance: float = 1.0
    """Share of households that leave when ordered; the rest stay (sim.demand participation)."""
    shadow_evacuation_share: float = 0.0
    """Share of a zone's vehicles that leave without an order once fire reaches the zone."""
    departure_delay_median_min: float | None = None
    """Order (or fire cue) to departure, lognormal median; None keeps TrafficParams.response_delay_median_min."""
    departure_delay_sigma: float | None = None

    def __post_init__(self) -> None:
        for name in ("order_compliance", "shadow_evacuation_share"):
            if not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be in [0, 1], got {getattr(self, name)!r}")
        if self.departure_delay_median_min is not None and not self.departure_delay_median_min > 0:
            raise ValueError("departure_delay_median_min must be positive")
        if self.departure_delay_sigma is not None and not self.departure_delay_sigma >= 0:
            raise ValueError("departure_delay_sigma must be nonnegative")

    @property
    def is_default(self) -> bool:
        return self == PeopleBehavior()


PEOPLE_PRESETS = {
    "historical": PeopleBehavior(),
    "camp_2018_sourced": PeopleBehavior(
        order_compliance=ORDER_COMPLIANCE_OCT2017_NORCAL, shadow_evacuation_share=SHADOW_EVACUATION_OCT2017_NORCAL,
        departure_delay_median_min=CAMP_DEPARTURE_DELAY_MEDIAN_MIN, departure_delay_sigma=DEPARTURE_DELAY_SIGMA),
}
"""`historical`: the replay as built (every household leaves when ordered, nobody without one, 30 min median).
`camp_2018_sourced`: compliance and shadow evacuation from Wong et al. 2020 (Oct 2017 N. California), departure
delay from the Camp survey (Grajdura 2022)."""


def people_from_spec(value) -> PeopleBehavior:
    """A preset name, or ``{"preset": name, ...overrides}``, or plain fields; None -> historical."""
    if value is None:
        return PeopleBehavior()
    if isinstance(value, str):
        if value not in PEOPLE_PRESETS:
            raise ValueError(f"unknown people preset {value!r}; one of {sorted(PEOPLE_PRESETS)}")
        return PEOPLE_PRESETS[value]
    d = dict(value)
    base = PEOPLE_PRESETS[d.pop("preset")] if "preset" in d else PeopleBehavior()
    return replace(base, **d)
