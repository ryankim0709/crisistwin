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

import json
import math
import random
from dataclasses import asdict, dataclass, field, replace
from functools import lru_cache
from pathlib import Path

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
    "Per-household choices (draw_household_choices) record trips, routes and destination types; the traffic "
    "engines do not yet move vehicles by them.",
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


# ---- Household choices from published evidence (sim/behavior_params.json; docs/people-data.md, "Behaviour
# evidence"). Each synthetic household draws its own warning reach, protective action, departure delay, trips,
# route strategy, destination, pets, vehicles and help needs. Every draw uses a random stream of its own, keyed
# on (seed, household key, choice name), so changing one household's (or one choice's) parameters never shifts
# another household's draws. Nothing here runs unless a caller asks for a profile: historical replays and the
# default residents generator are unchanged.

BEHAVIOR_PARAMS_PATH = Path(__file__).with_name("behavior_params.json")
"""Parameter file: every value with its evidence ids and label (sourced, derived, assumption, legacy)."""
PROFILE_LEGACY = "legacy"
"""Reproduces today's defaults (everyone told to leave leaves, 30 min lognormal delay, no trips back, guided
routes, half of the no-vehicle households ask for transport). For comparison runs."""
PROFILE_GROUNDED = "grounded"
"""Values from the wildfire evacuation literature: Camp 2018 where it exists, else other California fires,
else a labelled assumption (sim/behavior_params.json)."""

PROTECTIVE_ACTIONS = ("evacuate", "wait_and_see", "stay_and_defend", "shelter_in_place")
"""evacuate: leaves on its first warning or cue, or before any. wait_and_see: leaves only once it sees fire or
smoke itself (McLennan et al. 2014). stay_and_defend: stays to protect the property. shelter_in_place: stays
inside (or cannot leave) without defending."""
STAYING_ACTIONS = frozenset({"stay_and_defend", "shelter_in_place"})
DEPARTURE_TRIGGERS = ("before_warning", "warning", "fire_cue", "never")
EVIDENCE_LABELS = ("sourced", "derived", "assumption", "legacy")


def _choice_rng(seed: int, household_key: str, choice: str) -> random.Random:
    """An independent stream per (seed, household, choice). CPython seeds a str with SHA-512 (version 2), so
    the stream is the same across runs and processes."""
    return random.Random(f"{seed}:household-choice:{household_key}:{choice}")


def _validate_param(where: str, p: dict) -> None:
    kind = p.get("kind")
    if p.get("label") not in EVIDENCE_LABELS:
        raise ValueError(f"{where}: label must be one of {EVIDENCE_LABELS}")
    if kind == "bernoulli":
        if not 0 <= p["p"] <= 1:
            raise ValueError(f"{where}: p must be in [0, 1]")
    elif kind == "categorical":
        w = p["weights"]
        if not w or any(v < 0 for v in w.values()) or sum(w.values()) <= 0:
            raise ValueError(f"{where}: weights must be nonnegative with a positive sum")
    elif kind == "lognormal":
        if not (p["median_min"] > 0 and p["sigma"] >= 0 and p["max_min"] > 0):
            raise ValueError(f"{where}: lognormal needs median_min > 0, sigma >= 0, max_min > 0")
    elif kind == "by_hour":
        if not 0 <= p["default_p"] <= 1 or any(
                not (0 <= b["p"] <= 1 and 0 <= b["from_h"] < b["to_h"] <= 24) for b in p["bands"]):
            raise ValueError(f"{where}: by_hour needs default_p and bands with p in [0, 1], 0 <= from_h < to_h <= 24")
    else:
        raise ValueError(f"{where}: unknown kind {kind!r}")


@lru_cache(maxsize=4)
def load_behavior_params(path: str | None = None) -> dict:
    """The parameter file as a dict (cached per path). ValueError on an entry that is not well formed or that
    cites an evidence id the file does not define."""
    doc = json.loads(Path(path or BEHAVIOR_PARAMS_PATH).read_text())
    evidence = doc["evidence"]
    required = set(HOUSEHOLD_PARAM_NAMES)
    for name, prof in doc["profiles"].items():
        missing = required - set(prof["params"])
        if missing:
            raise ValueError(f"profile {name}: missing params {sorted(missing)}")
        for pid, p in prof["params"].items():
            for ev in p.get("evidence", ()):
                if ev not in evidence:
                    raise ValueError(f"profile {name} param {pid}: unknown evidence id {ev!r}")
            _validate_param(f"{name}.{pid}", p)
    return doc


def _draw(p: dict, rng: random.Random, *, local_hour: int | None = None):
    """One draw from a parameter entry (kinds: bernoulli, categorical, lognormal, by_hour)."""
    kind = p["kind"]
    if kind == "bernoulli":
        return rng.random() < p["p"]
    if kind == "categorical":
        keys = sorted(p["weights"])  # fixed order: the draw depends on the weights, not on the file's key order
        return rng.choices(keys, weights=[p["weights"][k] for k in keys])[0]
    if kind == "lognormal":
        return min(p["max_min"], rng.lognormvariate(math.log(p["median_min"]), p["sigma"]))
    # by_hour: a Bernoulli whose probability depends on the local clock hour
    band = next((b for b in p["bands"] if local_hour is not None and b["from_h"] <= local_hour < b["to_h"]), None)
    return rng.random() < (band["p"] if band else p["default_p"])


HOUSEHOLD_PARAM_NAMES = (
    "first_awareness", "official_order_received", "phone_alert_reached", "order_compliance", "shadow_evacuation",
    "stay_mode", "wait_and_see_given_compliance", "self_initiated_given_evacuate", "departure_delay", "milling",
    "trip_before_leaving", "trip_purpose", "route_strategy", "reroutes_in_congestion",
    "destination_type", "has_pets", "vehicles_taken", "needs_assistance", "help_request_no_vehicle",
    "help_request_needs_assistance",
)
"""Every profile in the parameter file defines all of these (load_behavior_params checks)."""


@dataclass(frozen=True)
class HouseholdContext:
    """What the caller knows about a household before its choices are drawn."""

    has_vehicle: bool = True
    """False for a no-vehicle household (ACS B25044): no draw gives it a car."""
    vehicles_available: int | None = None
    """Vehicles it owns, if known; caps vehicles_taken. None: the draw alone."""
    ordered: bool = True
    """Inside an order area; False draws the shadow-evacuation decision instead of order compliance."""
    local_hour: int | None = None
    """Local clock hour (0-23) of the first official alert; the phone-alert reach depends on it. None: default."""


@dataclass(frozen=True)
class HouseholdChoices:
    """One synthetic household's drawn behaviour (simulated, never observed). `sources` maps each field to the
    parameters it came from, with their label and evidence ids, so a UI can say which choices rest on evidence."""

    profile: str
    household_key: str
    first_awareness: str
    """How it first learns of the fire: saw_fire, in_person, call_or_text, online, tv_radio, official."""
    official_order_received: bool
    """Receives an official evacuation order at some point (any channel)."""
    phone_alert_reached: bool
    """An emergency phone call (CodeRED-style) reaches the household and connects; depends on the hour."""
    protective_action: str
    """One of PROTECTIVE_ACTIONS."""
    departure_trigger: str
    """One of DEPARTURE_TRIGGERS: before_warning, warning, fire_cue, never."""
    departure_delay_min: float | None
    """Minutes from its trigger (awareness or warning; the fire cue for wait-and-see) to leaving; None if it
    stays. Covers milling, preparation and any trips before leaving (the survey delay is the whole gap)."""
    milling: bool
    """Sought more information or confirmation before acting."""
    trip_before_leaving: str | None
    """Purpose of a trip made before evacuating (going back home or elsewhere first): family, others, pet,
    supplies, other; None if it drove straight out. Only the first trip's purpose is drawn."""
    pickup_trip: bool
    """The trip is to collect or help family away from home. Whether it heads toward the fire depends on where
    the family is, which the model does not know; the twin does not route it."""
    route_strategy: str | None
    """familiar, navigation (followed an app or GPS route), follow_others; None if it does not drive out."""
    reroutes_in_congestion: bool | None
    """Leaves its route for an alternative when queued; None if it does not drive out."""
    destination_type: str | None
    """friends_family, hotel, public_shelter, rv_or_camping, second_home, other; None if it stays."""
    has_pets: bool
    vehicles_taken: int
    """Vehicles it drives out (0 with no vehicle or when it stays)."""
    needs_assistance: bool
    """Has a member who needs help to evacuate (disability, medical) or has no vehicle."""
    requests_help: bool
    """Asks for help (transport, rescue) once its area is ordered or fire arrives."""
    sources: dict = field(default_factory=dict, compare=False)

    @property
    def evacuates(self) -> bool:
        return self.protective_action not in STAYING_ACTIONS

    def narrative(self) -> list[str]:
        """Plain-language lines for a UI about this simulated household."""
        out = [f"first heard of the fire: {self.first_awareness.replace('_', ' ')}"]
        out.append({"stay_and_defend": "stayed to defend the property",
                    "shelter_in_place": "stayed at home",
                    "wait_and_see": "waited to see the fire before leaving"}.get(self.protective_action, ""))
        if self.departure_trigger == "before_warning":
            out.append("left before any official warning")
        if self.milling:
            out.append("checked with others before deciding")
        if self.departure_delay_min is not None:
            out.append(f"left {round(self.departure_delay_min)} min after its trigger")
        if self.trip_before_leaving:
            out.append({"pet": "went back for a pet before leaving",
                        "supplies": "went to get belongings or supplies before leaving",
                        "family": "went to pick up family before leaving",
                        "others": "went to help friends or neighbours before leaving"}.get(
                self.trip_before_leaving, "made another trip before leaving"))
        if self.route_strategy:
            out.append({"familiar": "took a familiar route", "navigation": "followed a navigation app route",
                        "follow_others": "followed other cars"}[self.route_strategy])
        if self.destination_type:
            out.append(f"went to: {self.destination_type.replace('_', ' ')}")
        if self.requests_help:
            out.append("asked for help")
        return [s for s in out if s]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["narrative"] = self.narrative()
        return d


def household_params(profile: str = PROFILE_GROUNDED, path: str | None = None) -> dict:
    """The `params` of a profile in the parameter file."""
    doc = load_behavior_params(path)
    if profile not in doc["profiles"]:
        raise ValueError(f"unknown household behaviour profile {profile!r}; one of {sorted(doc['profiles'])}")
    return doc["profiles"][profile]["params"]


def draw_household_choices(seed: int, household_key: str, profile: str = PROFILE_GROUNDED,
                           context: HouseholdContext = HouseholdContext(), *, path: str | None = None
                           ) -> HouseholdChoices:
    """Draw one household's choices. Deterministic in (seed, household_key, profile, context). Each choice draws
    from its own stream (`_choice_rng`), so households are independent of each other and choices of each other
    (a conditional choice that is skipped consumes nothing from the others)."""
    P = household_params(profile, path)
    src: dict = {}

    def d(name: str, **kw):
        return _draw(P[name], _choice_rng(seed, household_key, name), **kw)

    def cite(fieldname: str, *params: str) -> None:
        src[fieldname] = [{"param": q, "label": P[q]["label"], "evidence": list(P[q].get("evidence", ()))}
                          for q in params]

    first_awareness = d("first_awareness")
    cite("first_awareness", "first_awareness")
    official = d("official_order_received")
    cite("official_order_received", "official_order_received")
    phone = d("phone_alert_reached", local_hour=context.local_hour)
    cite("phone_alert_reached", "phone_alert_reached")
    has_pets = d("has_pets")
    cite("has_pets", "has_pets")
    needs_assist = (not context.has_vehicle) or d("needs_assistance")
    cite("needs_assistance", "needs_assistance")

    # Protective action: in an order area comply or not; outside one, the shadow share leaves on the fire cue.
    complies = d("order_compliance") if context.ordered else d("shadow_evacuation")
    cite("protective_action", "order_compliance" if context.ordered else "shadow_evacuation", "stay_mode",
         "wait_and_see_given_compliance")
    if not complies:
        action = d("stay_mode")
        if not context.has_vehicle and action == "stay_and_defend":
            action = "shelter_in_place"  # assumption: a no-vehicle household that stays is not counted a defender
    elif context.ordered and d("wait_and_see_given_compliance"):
        action = "wait_and_see"
    else:
        action = "evacuate"
    evacuates = action not in STAYING_ACTIONS

    if not evacuates:
        trigger = "never"
    elif action == "wait_and_see" or not context.ordered:
        trigger = "fire_cue"
    elif d("self_initiated_given_evacuate"):
        trigger = "before_warning"
    else:
        trigger = "warning"
    cite("departure_trigger", "self_initiated_given_evacuate")
    delay = d("departure_delay") if evacuates else None
    cite("departure_delay_min", "departure_delay")
    milling = bool(d("milling")) if evacuates else False
    cite("milling", "milling")

    drives = evacuates and context.has_vehicle
    trip = None
    if drives and d("trip_before_leaving"):
        purposes = dict(P["trip_purpose"]["weights"])
        if not has_pets:
            purposes.pop("pet", None)  # a household without pets does not make a pet trip
        trip = _draw({"kind": "categorical", "weights": purposes}, _choice_rng(seed, household_key, "trip_purpose"))
    cite("trip_before_leaving", "trip_before_leaving", "trip_purpose")
    pickup = trip == "family"
    cite("pickup_trip", "trip_purpose")
    route = d("route_strategy") if drives else None
    cite("route_strategy", "route_strategy")
    reroute = d("reroutes_in_congestion") if drives else None
    cite("reroutes_in_congestion", "reroutes_in_congestion")
    dest = d("destination_type") if evacuates else None
    cite("destination_type", "destination_type")
    vehicles = 0
    if drives:
        vehicles = int(d("vehicles_taken"))
        if context.vehicles_available is not None:
            vehicles = max(1, min(vehicles, context.vehicles_available))
    cite("vehicles_taken", "vehicles_taken")
    if not context.has_vehicle:
        asks = d("help_request_no_vehicle")
        cite("requests_help", "help_request_no_vehicle")
    elif needs_assist:
        asks = d("help_request_needs_assistance")
        cite("requests_help", "help_request_needs_assistance")
    else:
        asks = False
        cite("requests_help")
    return HouseholdChoices(
        profile=profile, household_key=household_key, first_awareness=first_awareness,
        official_order_received=official, phone_alert_reached=phone, protective_action=action,
        departure_trigger=trigger, departure_delay_min=None if delay is None else round(delay, 2), milling=milling,
        trip_before_leaving=trip, pickup_trip=pickup, route_strategy=route, reroutes_in_congestion=reroute,
        destination_type=dest, has_pets=has_pets, vehicles_taken=vehicles, needs_assistance=needs_assist,
        requests_help=asks, sources=src)


def summarize_choices(choices) -> dict:
    """Shares over a sample of HouseholdChoices (reports, sanity checks)."""
    cs = list(choices)
    n = len(cs)
    if not n:
        return {"households": 0}

    def share(pred) -> float:
        return round(sum(1 for c in cs if pred(c)) / n, 4)

    def dist(attr) -> dict:
        out: dict = {}
        for c in cs:
            k = str(getattr(c, attr))
            out[k] = out.get(k, 0) + 1
        return {k: round(v / n, 4) for k, v in sorted(out.items())}

    delays = sorted(c.departure_delay_min for c in cs if c.departure_delay_min is not None)

    def q(f: float):
        return round(delays[min(len(delays) - 1, int(f * len(delays)))], 1) if delays else None

    return {
        "households": n,
        "protective_action": dist("protective_action"),
        "departure_trigger": dist("departure_trigger"),
        "first_awareness": dist("first_awareness"),
        "official_order_received": share(lambda c: c.official_order_received),
        "phone_alert_reached": share(lambda c: c.phone_alert_reached),
        "milling": share(lambda c: c.milling),
        "trip_before_leaving": dist("trip_before_leaving"),
        "pickup_trip": share(lambda c: c.pickup_trip),
        "route_strategy": dist("route_strategy"),
        "reroutes_in_congestion": dist("reroutes_in_congestion"),
        "destination_type": dist("destination_type"),
        "has_pets": share(lambda c: c.has_pets),
        "vehicles_taken": dist("vehicles_taken"),
        "needs_assistance": share(lambda c: c.needs_assistance),
        "requests_help": share(lambda c: c.requests_help),
        "departure_delay_min": {"p10": q(0.1), "p50": q(0.5), "p90": q(0.9),
                                "mean": round(sum(delays) / len(delays), 1) if delays else None},
    }


def people_from_household_profile(profile: str = PROFILE_GROUNDED) -> PeopleBehavior:
    """The fixed-delay twin's aggregate behaviour from a household profile, so the twin's vehicles and the
    residents' drawn choices agree: order compliance (households that eventually leave, wait-and-see included),
    shadow evacuation, and the departure-delay lognormal. The twin keeps its own 360 min cap
    (TrafficParams.response_delay_max_min); the households cap at the profile's max_min."""
    P = household_params(profile)
    delay = P["departure_delay"]
    return PeopleBehavior(order_compliance=P["order_compliance"]["p"],
                          shadow_evacuation_share=P["shadow_evacuation"]["p"],
                          departure_delay_median_min=delay["median_min"], departure_delay_sigma=delay["sigma"])


PEOPLE_PRESETS["grounded"] = people_from_household_profile(PROFILE_GROUNDED)
"""`grounded`: the same compliance (0.875) and shadow share (0.291) as camp_2018_sourced, and the departure delay
of the household `grounded` profile (median 42.8 min, sigma 1.246: Camp's 93 min mean with Marshall's spread).
Pair it with `residents.behavior_profile: "grounded"` (the batch runner does so automatically)."""
