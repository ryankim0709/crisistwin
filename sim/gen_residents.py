"""Simulated residents: phone data (check-ins, help, field reports, destination choices) from the traffic twin.

One seeded population of synthetic households per demand zone, tied to the twin's vehicles so that traffic
and phone activity tell one story (docs/adr/0030-scenario-engine.md, "Generators: people"). Design and
assumptions: docs/adr/0036-simulated-residents.md.

How households map to the twin
------------------------------
- A zone's `households` share its `vehicles` exactly (`allocate_vehicles`): at most `VEHICLES_TAKEN_CAP`
  each while possible, fewest carless households. Carless households own no twin vehicle and never leave.
- The twin's per-zone counters decide *how many* households are in each state. A seeded per-zone order (the
  departure rank) decides *which*: a household has departed once its first vehicle is among the zone's
  departed vehicles, and arrived once all its vehicles are among the zone's arrived vehicles. Counts are
  therefore conserved by construction (the twin itself asserts vehicle conservation).
- En-route households are placed on the twin's actual packets of their zone (edge queues, nodes waiting
  to enter an edge, turned-back packets), in order of remaining route cost, so a household's position,
  queue, closure and fire exposure are the twin's.

Events are dicts carrying the exact POST body the live API accepts (`docs/live-reports.md`; validators in
`app/backend/api/live/views.py`) plus `at` (drill time), `party_key` (synthetic, `sim_` prefix) and
`evidence_class: "simulated"`. Every rate below is a named constant marked ASSUMPTION or CALIBRATED.
Outputs are planning experiments, never observed data or resident alerts. Standard library only; it reads
the twin's engine state and never changes it.
"""

from __future__ import annotations

import hashlib
import heapq
import math
import random
import uuid
from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass, field
from datetime import timedelta

from sim.behavior import BehaviorParams
from sim.events import canonical_road_name
from sim.geo import EARTH_RADIUS_M
from sim.history import format_utc, parse_utc
from sim.traffic import CONGESTED_SPEED_FRACTION, REFUGE_KIND

GENERATOR_ID = "gen-residents"
GENERATOR_VERSION = "0.1.0"
EVIDENCE_CLASS = "simulated"
PARTY_KEY_PREFIX = "sim_"  # never dev_ or rsp_ (the server's real-token prefixes, api/live/views.py)
REPORT_NOTE = "Simulated resident (gen-residents)"

# ---- Live API shapes (mirrors app/backend/api/live/views.py; tests compare them with the server's sets)
REPORT_KINDS = frozenset({"road_blocked", "road_passable", "heavy_traffic", "fire_seen", "heavy_smoke",
                          "hazard_down", "shelter_full", "help_needed"})  # views.REPORT_KINDS
SEVERITIES = frozenset({"full", "partial", "slow"})  # views.SEVERITIES (null also allowed)
CHECKIN_STATUSES = frozenset({"out", "need_help", "staying"})  # views.CHECKIN_STATUSES
NOTE_MAX_CHARS = 500  # views.NOTE_MAX_CHARS
MAX_REPORTS_PER_HOUSEHOLD_PER_MIN = 6  # views.CIVILIAN_REPORTS_PER_MIN: the server's civilian rate limit

# ---- Mapping to the twin
VEHICLES_TAKEN_CAP = 2
"""Vehicles a household takes; same value and source as sim.demand.VEHICLES_TAKEN_CAP (literature: 1-2)."""
OBSERVE_EVERY_S = 60
"""Driver cadence: one observation per simulated minute (= TrafficParams.record_every_s default)."""

# ---- Population (ASSUMPTION unless marked)
APP_ADOPTION = 0.25
"""ASSUMPTION: share of households with the drill app. Opt-in emergency alert enrollment in California
wildfire areas has been reported at about 2% to 40% of residents: Sonoma SoCoAlerts about 2% (2017), Santa
Barbara Nixle about 9% (2019), NotifyLA 5% (2019), Paradise CodeRED under 40% (2018) (press reports
collected in docs/adr/0036-simulated-residents.md). 0.25 sits inside that range; it is not calibrated."""
STAYING_SHARE = 0.03
"""ASSUMPTION: share of vehicle households that tell the app they are staying when ordered or when fire
reaches their zone. They are taken from the end of the departure order, so they are the twin's last
departures; if the twin later moves their vehicle they check in `out` on arrival (the server keeps the
latest status). The twin has no shelter-in-place outcome (sim/behavior.py LIMITATIONS)."""

# ---- Check-ins (ASSUMPTION)
OUT_CHECKIN_SHARE = 0.8
"""ASSUMPTION: share of app households that check in `out` after their last vehicle arrives."""
OUT_CHECKIN_LAG_MEDIAN_MIN = 5.0
"""ASSUMPTION: arrival -> `out` check-in delay, lognormal median."""
OUT_CHECKIN_LAG_SIGMA = 0.8
"""ASSUMPTION: lognormal shape of that delay."""
OUT_CHECKIN_LAG_MAX_MIN = 60.0
"""ASSUMPTION: delay draws above this are capped."""

# ---- Help requests (ASSUMPTION; compared with, not fitted to, the 2018 record below)
NEED_HELP_HAZARD_AT_HOME_PER_H = 0.1
"""ASSUMPTION: hazard (per hour) that a household still at home (not departed, or carless) asks for help
while modelled fire has reached an origin node of its zone. Not fitted: the Camp record gives zone rates
per 1,000 households, not per household still at home, and the twin's departure model is uncalibrated."""
NEED_HELP_HAZARD_TRAPPED_PER_H = 0.5
"""ASSUMPTION: hazard (per hour) for a household whose vehicle the twin reports blocked (stopped on a
closed edge, or at a node with no open route; the twin's blocked_veh)."""

CAMP_RESCUE_RATE_FIRE_IN_ZONE_PER_KHH_H = 3.41
"""CALIBRATED reference (not used to generate): K-1 rescue rows per 1,000 households per hour in zones the
fire had reached, 0-2 h after the order (95% CI 2.71-4.25). docs/ground-data-calibration.md, section 2,
empirical table (NIST TN 2252 sample of the 2018 Camp Fire; branch feat/live-replay-sim, commit 03c33d8)."""
CAMP_911_RATE_FIRE_IN_ZONE_PER_KHH_H = 2.82
"""CALIBRATED reference (not used to generate): NIST-sampled 911 rows, same cell (95% CI 2.18-3.60). The
same document puts the true 911 volume at >= 3.67x the sample (a lower bound)."""
CAMP_911_SAMPLE_SCALE_MIN = 3.67
"""CALIBRATED reference: lower bound on 911 volume / NIST sample (docs/ground-data-calibration.md, sec. 5)."""

# ---- Field reports (ASSUMPTION)
REPORT_PROB_PER_ENCOUNTER = {"heavy_traffic": 0.05, "road_blocked": 0.2, "fire_seen": 0.1}
"""ASSUMPTION: chance an app household reports a situation once per encounter (per household and road for
heavy_traffic and road_blocked, a road being a canonical road name or else one segment; once per household
for fire_seen).
Participation inequality in user-generated content (the "90-9-1" heuristic) suggests most users never
post; these are guesses, not measurements."""
HEAVY_TRAFFIC_MIN_QUEUED_VEH = 10
"""ASSUMPTION: an edge is a queue worth reporting when at least this many vehicles wait to leave it
(about 80 m of stopped cars at the twin's 125 veh/km/lane jam density) ..."""
HEAVY_TRAFFIC_SPEED_FRACTION = CONGESTED_SPEED_FRACTION
"""... and its mean speed is below this fraction of free flow (the twin's own congestion definition,
sim/traffic.py CONGESTED_SPEED_FRACTION = 0.5)."""
FIRE_SIGHTING_DISTANCE_M = BehaviorParams().fire_cue_distance_m
"""ASSUMPTION reused from sim/behavior.py (fire_cue_distance_m, 2000 m: "sees smoke or flames" range):
a household within this distance of modelled fire (burned road-edge midpoints or burned origin nodes)
can report `fire_seen`."""
ROAD_BLOCKED_ENCOUNTER = ("event-closed own edge", "closed continuation of the same road at the node ahead",
                          "any closed edge leaving the node ahead when the twin reports the vehicle blocked")
"""ASSUMPTION: when a vehicle 'meets' a closed road (fire- or event-closed). Side streets closed by fire at an
intersection the vehicle drives through are not in its way and are not reported. A vehicle already driving
out over a fire-closed edge (the twin lets vehicles drain through burned road, TrafficParams.fire_escape_max_m)
is passing, not blocked, so the burned road ahead of it is not a road_blocked encounter either."""
REPORT_ACCURACY_M = 10.0
"""ASSUMPTION: phone GPS accuracy sent with reports (GPS.gov: smartphones typically within about 4.9 m
under open sky; worse under smoke, trees and in canyons)."""
COORD_DECIMALS = 6

# ---- Task board (ADR 0041; ASSUMPTION)
BOARD_ANSWER_SHARE = 0.3
"""ASSUMPTION: chance an app household answers a board question about the road it is driving on (once per
question). Only questions handed in through `board` (the public GET board items) are answered."""
PASSIVE_SETTING_SHARE = 0.2
"""ASSUMPTION: share of app households that turned on "Share road observations" (off by default on phones)."""
PASSIVE_KINDS = frozenset({"road_passable", "heavy_traffic"})  # views.PASSIVE_KINDS
SPEED_CLASSES = frozenset({"free", "slow"})  # views.SPEED_CLASSES

# ---- Destination choices (ASSUMPTION)
DESTINATION_CHOICE_SHARE = 0.3
"""ASSUMPTION: share of departing app households that pick a destination in the app."""
RECOMMENDED_CHOICE_SHARE = 0.7
"""ASSUMPTION: share of those who pick the recommended (first offered) destination; the rest pick
uniformly among the alternatives."""
DEFAULT_OFFERED_MAX = 3
"""Default offer list when no live guidance is passed: the nearest usable destinations (exits and shelters
before refuges, as livecore.planner ranks them), at most this many. A driver POSTing to a live server should
pass the zone's `guidance.alternatives` instead, or `me/destination` answers 400 invalid_destination."""

ASSUMPTIONS = [
    "Households are synthetic; none is a real resident. Each zone's households share its twin vehicles exactly "
    f"(at most {VEHICLES_TAKEN_CAP} each while possible, fewest carless).",
    "Within a zone, households leave and arrive in one seeded order (first in, first out); the twin's per-zone "
    "counts decide how many, the order decides which. En-route households sit on their zone's actual packets.",
    f"App adoption {APP_ADOPTION:g} of households (opt-in alert enrollment reported at 2-40% of residents).",
    f"{STAYING_SHARE:g} of vehicle households say they are staying; they are the zone's last departures.",
    f"{OUT_CHECKIN_SHARE:g} of app households check in out after arrival, after a lognormal delay "
    f"(median {OUT_CHECKIN_LAG_MEDIAN_MIN:g} min).",
    f"Help hazards: {NEED_HELP_HAZARD_AT_HOME_PER_H:g}/h at home with fire in the zone, "
    f"{NEED_HELP_HAZARD_TRAPPED_PER_H:g}/h when the twin reports the vehicle blocked; one request per household.",
    "Reports: once per encounter with probabilities " + ", ".join(
        f"{k} {v:g}" for k, v in sorted(REPORT_PROB_PER_ENCOUNTER.items())) + f"; fire seen within "
    f"{FIRE_SIGHTING_DISTANCE_M:g} m; heavy traffic at >= {HEAVY_TRAFFIC_MIN_QUEUED_VEH} queued vehicles and "
    f"< {HEAVY_TRAFFIC_SPEED_FRACTION:g} of free-flow speed.",
    f"{DESTINATION_CHOICE_SHARE:g} of departing app households choose a destination; "
    f"{RECOMMENDED_CHOICE_SHARE:g} of them the recommended one. Choices do not steer the twin's vehicles.",
    f"Task board (when given): {BOARD_ANSWER_SHARE:g} chance to answer a question about the road being driven; "
    f"{PASSIVE_SETTING_SHARE:g} of app households share passive road observations (one per question).",
]
LIMITATIONS = [
    "Which household is in which packet is assigned, not tracked: the fixed-delay twin does not carry packet "
    "identity past departure.",
    "Help rates are assumptions; the Camp record's zone rates are reported next to them, not fitted.",
    "One seed is one draw; compare strategies over several seeds.",
]


@dataclass(frozen=True)
class ResidentParams:
    seed: int = 20181108
    app_adoption: float = APP_ADOPTION
    staying_share: float = STAYING_SHARE
    out_checkin_share: float = OUT_CHECKIN_SHARE
    out_lag_median_min: float = OUT_CHECKIN_LAG_MEDIAN_MIN
    out_lag_sigma: float = OUT_CHECKIN_LAG_SIGMA
    out_lag_max_min: float = OUT_CHECKIN_LAG_MAX_MIN
    help_at_home_per_h: float = NEED_HELP_HAZARD_AT_HOME_PER_H
    help_trapped_per_h: float = NEED_HELP_HAZARD_TRAPPED_PER_H
    report_prob: dict = field(default_factory=lambda: dict(REPORT_PROB_PER_ENCOUNTER))
    heavy_traffic_min_queued_veh: int = HEAVY_TRAFFIC_MIN_QUEUED_VEH
    heavy_traffic_speed_fraction: float = HEAVY_TRAFFIC_SPEED_FRACTION
    fire_sighting_distance_m: float = FIRE_SIGHTING_DISTANCE_M
    destination_choice_share: float = DESTINATION_CHOICE_SHARE
    recommended_choice_share: float = RECOMMENDED_CHOICE_SHARE
    board_answer_share: float = BOARD_ANSWER_SHARE
    passive_setting_share: float = PASSIVE_SETTING_SHARE

    def __post_init__(self) -> None:
        for name in ("app_adoption", "staying_share", "out_checkin_share", "destination_choice_share",
                     "recommended_choice_share", "heavy_traffic_speed_fraction", "board_answer_share",
                     "passive_setting_share"):
            if not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be in [0, 1], got {getattr(self, name)!r}")
        for name in ("help_at_home_per_h", "help_trapped_per_h", "out_lag_sigma", "fire_sighting_distance_m"):
            v = getattr(self, name)
            if not (math.isfinite(v) and v >= 0):
                raise ValueError(f"{name} must be nonnegative and finite, got {v!r}")
        for name in ("out_lag_median_min", "out_lag_max_min"):
            v = getattr(self, name)
            if not (math.isfinite(v) and v > 0):
                raise ValueError(f"{name} must be positive and finite, got {v!r}")
        if set(self.report_prob) != set(REPORT_PROB_PER_ENCOUNTER) or not all(
                0 <= p <= 1 for p in self.report_prob.values()):
            raise ValueError(f"report_prob needs probabilities for {sorted(REPORT_PROB_PER_ENCOUNTER)}")

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- population


@dataclass
class Household:
    index: int  # within its zone, 0..households-1 (synthetic)
    zone_id: str
    party_key: str
    vehicles: int  # twin vehicles it owns; 0 = carless
    origin_node: int  # engine node index (where it starts); -1 when the zone has no origin node
    has_app: bool
    stays: bool  # tells the app it is staying (see STAYING_SHARE)
    rank: int  # position in the zone's departure order; carless households rank after every vehicle household


def allocate_vehicles(households: int, vehicles: int) -> list[int]:
    """Vehicles per household summing exactly to `vehicles`: 1 each, a second for some while possible
    (VEHICLES_TAKEN_CAP), extra beyond that round-robin; carless (0) only when vehicles < households."""
    if households <= 0:
        return []
    if vehicles < households:
        return [1] * vehicles + [0] * (households - vehicles)
    out = [1] * households
    extra = vehicles - households
    k = 0
    while extra > 0:
        out[k % households] += 1
        extra -= 1
        k += 1
    return out


def party_key(seed: int, zone_id: str, index: int) -> str:
    """Stable synthetic party id; depends only on (seed, zone, household index)."""
    return PARTY_KEY_PREFIX + hashlib.sha256(f"{seed}:{zone_id}:{index}".encode()).hexdigest()[:16]


@dataclass
class ZonePopulation:
    zone_id: str
    zi: int
    households: list[Household]
    order: list[Household]  # vehicle households in departure-rank order
    carless: list[Household]
    cum_before: list[int]  # vehicles of the households ranked before each one in `order`
    cum_after: list[int]  # ... including it
    origin_nodes: frozenset[int]
    centroid: tuple[float, float]


def build_population(engine, params: ResidentParams) -> list[ZonePopulation]:
    """Households per twin zone (scenario order). Deterministic in (params.seed, zone ids, zone counts)."""
    s = engine.s
    nodes = s.network.nodes
    pops = []
    for zi, z in enumerate(s.zone_list):
        rng = random.Random(f"{params.seed}:{GENERATOR_ID}:population:{z.id}")
        alloc = allocate_vehicles(z.households, z.vehicles)
        rng.shuffle(alloc)  # which household index owns two vehicles is seeded
        origin_ix = [s.node_ix[n] for n in z.origin_nodes]
        hh = [Household(index=h, zone_id=z.id, party_key=party_key(params.seed, z.id, h), vehicles=alloc[h],
                        origin_node=origin_ix[h % len(origin_ix)] if origin_ix else -1,
                        has_app=rng.random() < params.app_adoption, stays=False, rank=-1)
              for h in range(len(alloc))]
        movers = [h for h in hh if h.vehicles > 0]
        rng.shuffle(movers)
        n_stay = round(params.staying_share * len(movers))
        for r, h in enumerate(movers):
            h.rank = r
            h.stays = r >= len(movers) - n_stay
        carless = [h for h in hh if h.vehicles == 0]
        for r, h in enumerate(carless, start=len(movers)):
            h.rank = r
        cum_before, cum_after, c = [], [], 0
        for h in movers:
            cum_before.append(c)
            c += h.vehicles
            cum_after.append(c)
        if hh and c != z.vehicles:
            raise AssertionError(f"zone {z.id}: households own {c} vehicles, the twin has {z.vehicles}")
        pts = [nodes[n] for n in z.origin_nodes] or [(0.0, 0.0)]
        pops.append(ZonePopulation(z.id, zi, hh, movers, carless, cum_before, cum_after, frozenset(origin_ix),
                                   (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))))
    return pops


# ---------------------------------------------------------------- geometry


class _PointIndex:
    """Points bucketed by a square cell (local equirectangular metres) for 'any point within d' queries."""

    def __init__(self, points, d_m: float, lat0: float):
        self.d = max(d_m, 1.0)
        self.m_lat = math.radians(1) * EARTH_RADIUS_M
        self.m_lon = self.m_lat * math.cos(math.radians(lat0))
        self.buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for lon, lat in points:
            x, y = lon * self.m_lon, lat * self.m_lat
            self.buckets.setdefault((math.floor(x / self.d), math.floor(y / self.d)), []).append((x, y))

    def within(self, lon: float, lat: float) -> bool:
        x, y = lon * self.m_lon, lat * self.m_lat
        cx, cy = math.floor(x / self.d), math.floor(y / self.d)
        d2 = self.d * self.d
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for px, py in self.buckets.get((i, j), ()):
                    if (px - x) ** 2 + (py - y) ** 2 <= d2:
                        return True
        return False


def _coord(p) -> list[float]:
    return [round(float(p[0]), COORD_DECIMALS), round(float(p[1]), COORD_DECIMALS)]


# ---------------------------------------------------------------- event shapes


def _client_id(seed: int, party: str, n: int) -> str:
    digest = hashlib.sha256(f"{seed}:{party}:{n}".encode()).digest()
    return str(uuid.UUID(bytes=digest[:16], version=4))


def report_body(*, client_id: str, kind: str, coord, observed_at: str, severity: str | None = None,
                incident_id: str | None = None, note: str | None = REPORT_NOTE) -> dict:
    """POST incidents/{id}/reports body (docs/live-reports.md: every stored field except the server-filled
    id, reporter, road_ref, received_at, status and evidence_class)."""
    body = {"client_id": client_id, "kind": kind, "severity": severity,
            "location": {"coord": _coord(coord), "accuracy_m": REPORT_ACCURACY_M}, "heading_deg": None,
            "destination_id": None, "task_id": None, "observed_at": observed_at, "note": note}
    if incident_id is not None:
        body["incident_id"] = incident_id
    return body


def passive_body(*, client_id: str, kind: str, segment_id: str, speed_class: str, observed_at: str,
                 task_id: str | None, incident_id: str | None = None) -> dict:
    """A passive road observation (ADR 0041): segment, time and coarse speed class; no location."""
    body = {"client_id": client_id, "kind": kind, "method": "passive", "segment_id": segment_id,
            "speed_class": speed_class, "task_id": task_id, "observed_at": observed_at,
            "severity": "slow" if kind == "heavy_traffic" else None}
    if incident_id is not None:
        body["incident_id"] = incident_id
    return body


def checkin_body(status: str, zone_id: str | None, coord=None) -> dict:
    """POST incidents/{id}/checkins body; `coord` only with need_help (else the server answers 400)."""
    body = {"status": status, "zone_id": zone_id}
    if status == "need_help" and coord is not None:
        body["coord"] = _coord(coord)
    return body


def destination_body(zone_id: str, destination_id: str) -> dict:
    """POST me/destination body."""
    return {"zone_id": zone_id, "destination_id": destination_id}


ENDPOINTS = {"report": "incidents/{incident_id}/reports", "checkin": "incidents/{incident_id}/checkins",
             "destination": "me/destination"}


def validate_body(event: dict) -> None:
    """Raise ValueError unless the body passes the live API's input checks (a stdlib mirror of
    views._validate_report, views.checkins and views.my_destination; server-state checks such as known
    zone or offered destination are left to the server)."""
    t, b = event["type"], event["body"]

    def coord_ok(c) -> bool:
        return (isinstance(c, list) and len(c) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                                                              for v in c)
                and math.isfinite(c[0]) and math.isfinite(c[1]) and -180 <= c[0] <= 180 and -90 <= c[1] <= 90)

    if t == "report" and b.get("method") == "passive":
        uuid.UUID(str(b.get("client_id")))
        if b.get("kind") not in PASSIVE_KINDS:
            raise ValueError("a passive report is road_passable or heavy_traffic")
        if any(b.get(k) is not None for k in ("location", "heading_deg", "note", "destination_id")):
            raise ValueError("a passive report carries no location, heading, note or destination")
        if not isinstance(b.get("segment_id"), str) or b.get("speed_class") not in SPEED_CLASSES:
            raise ValueError("segment_id and speed_class")
        if b["kind"] == "heavy_traffic" and b["speed_class"] != "slow":
            raise ValueError("passive heavy_traffic needs speed_class slow")
        obs = b.get("observed_at")
        if not isinstance(obs, str) or not obs.endswith("Z"):
            raise ValueError("observed_at must be ISO 8601 with Z")
        parse_utc(obs)
    elif t == "report":
        uuid.UUID(str(b.get("client_id")))
        if b.get("kind") not in REPORT_KINDS:
            raise ValueError(f"kind {b.get('kind')!r}")
        if b.get("severity") is not None and b["severity"] not in SEVERITIES:
            raise ValueError("severity")
        loc = b.get("location")
        if not isinstance(loc, dict) or not coord_ok(loc.get("coord")):
            raise ValueError("location.coord")
        acc = loc.get("accuracy_m")
        if acc is not None and (not isinstance(acc, (int, float)) or acc < 0):
            raise ValueError("accuracy_m")
        h = b.get("heading_deg")
        if h is not None and not 0 <= h <= 360:
            raise ValueError("heading_deg")
        if b.get("kind") == "shelter_full" and not b.get("destination_id"):
            raise ValueError("shelter_full needs destination_id")
        obs = b.get("observed_at")
        if not isinstance(obs, str) or not obs.endswith("Z"):
            raise ValueError("observed_at must be ISO 8601 with Z")
        parse_utc(obs)
        if b.get("note") is not None and (not isinstance(b["note"], str) or len(b["note"]) > NOTE_MAX_CHARS):
            raise ValueError("note")
    elif t == "checkin":
        if b.get("status") not in CHECKIN_STATUSES:
            raise ValueError("status")
        if b.get("coord") is not None and (b["status"] != "need_help" or not coord_ok(b["coord"])):
            raise ValueError("coord only with need_help")
    elif t == "destination":
        if not isinstance(b.get("zone_id"), str) or not isinstance(b.get("destination_id"), str):
            raise ValueError("zone_id and destination_id are required")
    else:
        raise ValueError(f"unknown event type {t!r}")


# ---------------------------------------------------------------- generator


@dataclass
class _HState:
    out_at: str | None = None  # `out` scheduled or emitted
    help_latent: bool = False  # drew a help request (app or not)
    staying_sent: bool = False
    fire_seen: bool = False
    chose: bool = False
    traffic_roads: set = field(default_factory=set)  # road keys already met in a queue
    blocked_roads: set = field(default_factory=set)  # road keys already met closed
    report_times: list = field(default_factory=list)
    board_seen: set = field(default_factory=set)  # board task ids already answered or passed


class ResidentGenerator:
    """Observe a sim.twin.Twin at increasing times and emit simulated resident events.

    Call `observe()` after each `twin.step_to(...)`; it returns the new events with `at <= twin.now`, in
    time order. `offered(zone_id, at_iso) -> [destination_id, ...]` (recommended first) supplies the
    destinations a zone's guidance offers; by default the nearest usable twin destinations.
    `board(at_iso) -> [board item, ...]` (optional; the `items` of GET incidents/{id}/board) supplies open
    board questions: a household driving a question's segment answers it, or sends a passive observation if
    it shares road observations (ADR 0041). Without `board` the event stream is unchanged.
    """

    def __init__(self, twin, params: ResidentParams | None = None, *, incident_id: str | None = None,
                 offered=None, board=None):
        self.twin = twin
        self.engine = twin.engine
        self.p = params or ResidentParams()
        self.incident_id = incident_id
        self.offered = offered or self._default_offered
        self.board = board
        self.board_rng = random.Random(f"{self.p.seed}:{GENERATOR_ID}:board")  # separate: board use leaves the rest unchanged
        self.pops = build_population(self.engine, self.p)
        self.state: dict[str, _HState] = {h.party_key: _HState() for z in self.pops for h in z.households}
        self.rng = random.Random(f"{self.p.seed}:{GENERATOR_ID}:events")
        self.last_t_s: float | None = None
        self.prev_departed = [0] * len(self.pops)  # households departed at the previous observation
        self.prev_arrived = [0] * len(self.pops)
        self.pending: list[tuple[str, int, dict]] = []  # (at, seq, event): delayed out check-ins
        self.seq = 0
        self.n_msgs: dict[str, int] = {}
        s = self.engine.s
        self.out_edges: list[list[int]] = [[] for _ in s.node_ids]
        for i, f in enumerate(s.e_from):
            self.out_edges[f].append(i)
        lats = [lat for _, lat in s.network.nodes.values()] or [0.0]
        self.lat0 = (min(lats) + max(lats)) / 2
        self._fire_index = None
        self._fire_key = None
        # Accounting for rate checks (all households, app or not).
        self.exposure_h = {"at_home_fire": 0.0, "trapped": 0.0}
        self.latent_help = {"at_home_fire": 0, "trapped": 0}
        self.fire_zone_khh_h = 0.0  # 1,000 households x hours in zones with fire at an origin node
        self.fire_zone_latent_help = 0

    # --- helpers

    def _now_iso(self) -> str:
        return self.twin.now

    def _event(self, typ: str, hh: Household, at: str, body: dict, cause: dict) -> dict:
        ev = {"type": typ, "method": "POST", "path": ENDPOINTS[typ].format(incident_id=self.incident_id or "{incident_id}"),
              "body": body, "at": at, "party_key": hh.party_key, "evidence_class": EVIDENCE_CLASS,
              "zone_id": hh.zone_id, "household": hh.index, "cause": cause,
              "generator": f"{GENERATOR_ID}@{GENERATOR_VERSION}"}
        return ev

    def _report(self, hh: Household, st: _HState, kind: str, coord, at: str, cause: dict,
                severity: str | None, t_s: float) -> dict | None:
        recent = [x for x in st.report_times if x > t_s - 60]
        if len(recent) >= MAX_REPORTS_PER_HOUSEHOLD_PER_MIN:
            return None
        st.report_times = recent + [t_s]
        n = self.n_msgs[hh.party_key] = self.n_msgs.get(hh.party_key, 0) + 1
        body = report_body(client_id=_client_id(self.p.seed, hh.party_key, n), kind=kind, coord=coord,
                           observed_at=at, severity=severity, incident_id=self.incident_id)
        return self._event("report", hh, at, body, cause)

    def shares_road_observations(self, party_key: str) -> bool:
        """The household's per-device setting, a seeded draw that does not touch the event stream."""
        digest = hashlib.sha256(f"{self.p.seed}:{party_key}:passive".encode()).digest()
        return int.from_bytes(digest[:8], "big") / 2 ** 64 < self.p.passive_setting_share

    def _board_events(self, hh: Household, st: _HState, info: dict, questions: dict, at: str,
                      t_s: float) -> list[dict]:
        """Answer or passively complete a board question about the edge the household is on."""
        if info["kind"] != "edge" or info["edge"] is None:
            return []
        seg = self.engine.s.edges[info["edge"]].segment_id
        item = questions.get(seg)
        if item is None or item["task_id"] in st.board_seen:
            return []
        st.board_seen.add(item["task_id"])
        cause = {"state": "board_question", "at": at, "edge_index": info["edge"], "task_id": item["task_id"]}
        if self.board_rng.random() < self.p.board_answer_share:
            kind, severity = (("road_blocked", "full") if info["blocked"]
                              else ("heavy_traffic", "slow") if info["congested"] else ("road_passable", None))
            ev = self._report(hh, st, kind, item["place"]["coord"], at, cause, severity, t_s)
            if ev:
                ev["body"]["task_id"] = item["task_id"]
            return [ev] if ev else []
        if info["blocked"] or not self.shares_road_observations(hh.party_key):
            return []  # a stopped phone never infers anything passively
        speed = "slow" if info["congested"] else "free"
        out = []
        for kind in ("road_passable",) + (("heavy_traffic",) if speed == "slow" else ()):
            recent = [x for x in st.report_times if x > t_s - 60]
            if len(recent) >= MAX_REPORTS_PER_HOUSEHOLD_PER_MIN:
                break
            st.report_times = recent + [t_s]
            n = self.n_msgs[hh.party_key] = self.n_msgs.get(hh.party_key, 0) + 1
            body = passive_body(client_id=_client_id(self.p.seed, hh.party_key, n), kind=kind, segment_id=seg,
                                speed_class=speed, observed_at=at, task_id=item["task_id"],
                                incident_id=self.incident_id)
            out.append(self._event("report", hh, at, body, {**cause, "state": "board_passive"}))
        return out

    def _default_offered(self, zone_id: str, at: str) -> list[str]:
        e, s = self.engine, self.engine.s
        pop = next(z for z in self.pops if z.zone_id == zone_id)
        cx, cy = pop.centroid
        m_lon = math.cos(math.radians(self.lat0))
        usable = [(d.kind == REFUGE_KIND, (d.coord[0] - cx) ** 2 * m_lon ** 2 + (d.coord[1] - cy) ** 2, d.id)
                  for k, d in enumerate(s.dest_list) if e.dest_open[k] and not e.dest_full[k]]
        return [d for _, _, d in sorted(usable)[:DEFAULT_OFFERED_MAX]]

    def _fire(self):
        """Index of modelled fire points: midpoints of fire-exposed edges and burned origin nodes."""
        e, s = self.engine, self.engine.s
        key = (len(e.exposed_edges), len(e.origin_burned))
        if key != self._fire_key:
            pts = [s.e_mid[i] for i in e.exposed_edges] + [s.network.nodes[s.node_ids[n]] for n in e.origin_burned]
            self._fire_index = _PointIndex(pts, self.p.fire_sighting_distance_m, self.lat0) if pts else None
            self._fire_key = key
        return self._fire_index

    def _slots(self, t_s: float):
        """Per zone: the twin's packets of that zone as (sort key, vehicles, info), most advanced first."""
        e, s = self.engine, self.engine.s
        e_to, nodes, node_ids = s.e_to, s.network.nodes, s.node_ids
        per_zone: list[list] = [[] for _ in self.pops]
        edge_info: dict[int, dict] = {}
        for i in sorted(e.active):
            q = e.queue[i]
            occ = e.occ[i]
            if not q or occ <= 0:
                continue
            stopped = e.closed[i] and i in e.closed_hard
            dn = e_to[i]
            no_route = e.next_edge[dn] == -1 and e.open_dest_at(dn) is None
            queued = sum(p[0] for p in q if p[1] <= t_s)
            ratio = 0.0 if stopped else (occ - queued) / occ
            info = {"kind": "edge", "edge": i, "node": dn, "coord": s.e_mid[i], "blocked": stopped or no_route,
                    "cause": ("trapped_by_closure" if stopped else "trapped_by_fire" if i in e.exposed_edges
                              else "no_route") if (stopped or no_route) else None,
                    "congested": (not stopped and queued >= self.p.heavy_traffic_min_queued_veh
                                  and ratio < self.p.heavy_traffic_speed_fraction),
                    "queued_veh": queued}
            edge_info[i] = info
            base = e.route_dist[dn]
            for p in q:
                per_zone[p[2]].append(((base + max(0.0, p[1] - t_s), 0, i), p[0], info))
        for node in sorted(e.waiting):
            wq = e.waiting[node]
            if not wq:
                continue
            blocked = e.next_edge[node] == -1 and e.open_dest_at(node) is None
            info = {"kind": "node", "edge": None, "node": node, "coord": nodes[node_ids[node]], "blocked": blocked,
                    "cause": "no_route" if blocked else None, "congested": False, "queued_veh": 0}
            for p in wq:
                per_zone[p[1]].append(((e.route_dist[node], 1, node), p[0], info))
        for r in e.returning:  # (at_s, seq, node, count, zone, agent): turned back, driving to node
            info = {"kind": "node", "edge": None, "node": r[2], "coord": nodes[node_ids[r[2]]], "blocked": False,
                    "cause": None, "congested": False, "queued_veh": 0}
            per_zone[r[4]].append(((e.route_dist[r[2]], 2, r[1]), r[3], info))
        for lst in per_zone:
            lst.sort(key=lambda x: x[0])
        return per_zone

    def _road_key(self, i: int) -> str:
        """One road per canonical name (sim.events.canonical_road_name), else per segment."""
        edge = self.engine.s.edges[i]
        return canonical_road_name(edge.name or "") or f"segment:{edge.segment_id}"

    def _closed_ahead(self, info: dict, st: _HState) -> tuple[int, str] | None:
        """A closed road in this vehicle's way that it has not met before (ROAD_BLOCKED_ENCOUNTER)."""
        e, s = self.engine, self.engine.s
        cands = []
        i = info["edge"]
        if i is not None and (i in e.event_closed or i in e.event_closed_drain):
            cands.append(i)
        back = s.twin[i] if i is not None else None
        own = self._road_key(i) if i is not None else None
        passing = i is not None and i in e.fire_closed  # already driving out through burned road
        for j in self.out_edges[info["node"]]:
            if j != back and (j in e.fire_closed or j in e.event_closed or j in e.event_closed_drain) and (
                    info["blocked"] or (self._road_key(j) == own and not passing)):
                cands.append(j)
        for j in sorted(cands):
            key = self._road_key(j)
            if key not in st.blocked_roads:
                return j, key
        return None

    # --- the step

    def observe(self) -> list[dict]:
        e, s, p, rng = self.engine, self.engine.s, self.p, self.rng
        t_s = e.now_s
        if t_s is None or (self.last_t_s is not None and t_s <= self.last_t_s):
            return []
        dt_h = 0.0 if self.last_t_s is None else (t_s - self.last_t_s) / 3600.0
        self.last_t_s = t_s
        at = self._now_iso()
        now_dt = parse_utc(at)
        out: list[dict] = []
        fire = self._fire()
        slots = self._slots(t_s)
        p_home = 1.0 - math.exp(-p.help_at_home_per_h * dt_h)
        p_trap = 1.0 - math.exp(-p.help_trapped_per_h * dt_h)
        burned = e.origin_burned
        questions = {}
        if self.board is not None:
            for item in self.board(at) or []:
                place = item.get("place") or {}
                if item.get("question") == "road_status" and place.get("segment_id"):
                    questions.setdefault(place["segment_id"], item)

        for pop in self.pops:
            if not pop.households:
                continue
            zi = pop.zi
            departed_veh = e.z_departed[zi]
            arrived_veh = e.z_arrived[zi]
            n_dep = bisect_left(pop.cum_before, departed_veh)  # first vehicle has left
            n_arr = bisect_right(pop.cum_after, arrived_veh)  # every vehicle has arrived
            if n_dep < self.prev_departed[zi] or n_arr < self.prev_arrived[zi] or n_arr > n_dep:
                raise AssertionError(f"zone {pop.zone_id}: household states went backwards or out of order")
            fire_in_zone = bool(pop.origin_nodes & burned)
            ordered = (e.z_ordered_s[zi] if s.agents_on else e.first_release_s.get(pop.zone_id)) is not None
            if fire_in_zone and dt_h > 0:
                self.fire_zone_khh_h += len(pop.households) / 1000.0 * dt_h

            # Arrivals: schedule `out` check-ins.
            for hh in pop.order[self.prev_arrived[zi]:n_arr]:
                st = self.state[hh.party_key]
                if hh.has_app and st.out_at is None and rng.random() < p.out_checkin_share:
                    lag_s = min(p.out_lag_max_min * 60,
                                rng.lognormvariate(math.log(p.out_lag_median_min * 60), p.out_lag_sigma))
                    out_at = format_utc(now_dt + timedelta(seconds=math.ceil(lag_s)))
                    st.out_at = out_at
                    ev = self._event("checkin", hh, out_at, checkin_body("out", pop.zone_id),
                                     {"state": "arrived", "at": at})
                    heapq.heappush(self.pending, (out_at, self.seq, ev))
                    self.seq += 1

            # Departures: destination choices.
            for hh in pop.order[self.prev_departed[zi]:n_dep]:
                st = self.state[hh.party_key]
                if hh.has_app and not st.chose and rng.random() < p.destination_choice_share:
                    st.chose = True
                    offers = list(self.offered(pop.zone_id, at) or [])
                    if offers:
                        if len(offers) == 1 or rng.random() < p.recommended_choice_share:
                            dest = offers[0]
                        else:
                            dest = offers[1 + rng.randrange(len(offers) - 1)]
                        out.append(self._event("destination", hh, at, destination_body(pop.zone_id, dest),
                                               {"state": "departed", "at": at, "offered": offers}))
            self.prev_departed[zi], self.prev_arrived[zi] = n_dep, n_arr

            # At home: vehicle households not departed, and carless households.
            for hh in pop.order[n_dep:] + pop.carless:
                st = self.state[hh.party_key]
                home = s.network.nodes[s.node_ids[hh.origin_node]] if hh.origin_node >= 0 else pop.centroid
                if hh.stays and hh.has_app and not st.staying_sent and (ordered or fire_in_zone):
                    st.staying_sent = True
                    out.append(self._event("checkin", hh, at, checkin_body("staying", pop.zone_id),
                                           {"state": "not_departed_staying", "at": at,
                                            "trigger": "fire_in_zone" if fire_in_zone else "order"}))
                if fire_in_zone and dt_h > 0 and not st.help_latent:
                    self.exposure_h["at_home_fire"] += dt_h
                    if rng.random() < p_home:
                        st.help_latent = True
                        self.latent_help["at_home_fire"] += 1
                        self.fire_zone_latent_help += 1
                        if hh.has_app:
                            out.append(self._event("checkin", hh, at, checkin_body("need_help", pop.zone_id, home),
                                                   {"state": "not_departed_fire_in_zone", "at": at}))
                if (hh.has_app and not st.fire_seen and fire is not None and fire.within(*home)):
                    st.fire_seen = True
                    if rng.random() < p.report_prob["fire_seen"]:
                        ev = self._report(hh, st, "fire_seen", home, at, {"state": "fire_within_sighting", "at": at,
                                                                          "where": "home"}, None, t_s)
                        if ev:
                            out.append(ev)

            # En route: place households on the zone's packets, most advanced first.
            zslots = slots[zi]
            ends, c = [], 0
            for _, n, _ in zslots:
                c += n
                ends.append(c)
            if c != departed_veh - arrived_veh:
                raise AssertionError(f"zone {pop.zone_id}: {c} vehicles on the road, twin says "
                                     f"{departed_veh - arrived_veh}")
            for hh in pop.order[n_arr:n_dep]:
                r = hh.rank
                offset = max(pop.cum_before[r], arrived_veh) - arrived_veh
                if offset >= c:
                    # Some of its vehicles arrived, the rest have not left: the household is at home.
                    home = s.network.nodes[s.node_ids[hh.origin_node]]
                    info = {"kind": "home", "edge": None, "node": hh.origin_node, "coord": home, "blocked": False,
                            "cause": None, "congested": False, "queued_veh": 0}
                else:
                    info = zslots[bisect_right(ends, offset)][2]
                st = self.state[hh.party_key]
                if info["blocked"] and dt_h > 0 and not st.help_latent:
                    self.exposure_h["trapped"] += dt_h
                    if rng.random() < p_trap:
                        st.help_latent = True
                        self.latent_help["trapped"] += 1
                        if fire_in_zone:
                            self.fire_zone_latent_help += 1
                        if hh.has_app:
                            out.append(self._event("checkin", hh, at,
                                                   checkin_body("need_help", pop.zone_id, info["coord"]),
                                                   {"state": info["cause"], "at": at, "edge_index": info["edge"],
                                                    "node_index": info["node"]}))
                if not hh.has_app:
                    continue
                if questions:
                    out.extend(self._board_events(hh, st, info, questions, at, t_s))
                if info["congested"] and self._road_key(info["edge"]) not in st.traffic_roads:
                    st.traffic_roads.add(self._road_key(info["edge"]))
                    if rng.random() < p.report_prob["heavy_traffic"]:
                        ev = self._report(hh, st, "heavy_traffic", info["coord"], at,
                                          {"state": "queue", "at": at, "edge_index": info["edge"],
                                           "queued_veh": info["queued_veh"]}, "slow", t_s)
                        if ev:
                            out.append(ev)
                met = self._closed_ahead(info, st)
                if met is not None:
                    j, key = met
                    st.blocked_roads.add(key)
                    if rng.random() < p.report_prob["road_blocked"]:
                        cause = "fire_closed" if j in e.fire_closed else "event_closed"
                        ev = self._report(hh, st, "road_blocked", s.e_mid[j], at,
                                          {"state": cause, "at": at, "edge_index": j}, "full", t_s)
                        if ev:
                            out.append(ev)
                if not st.fire_seen and fire is not None and fire.within(*info["coord"]):
                    st.fire_seen = True
                    if rng.random() < p.report_prob["fire_seen"]:
                        ev = self._report(hh, st, "fire_seen", info["coord"], at,
                                          {"state": "fire_within_sighting", "at": at, "where": "road"}, None, t_s)
                        if ev:
                            out.append(ev)

        while self.pending and self.pending[0][0] <= at:
            out.append(heapq.heappop(self.pending)[2])
        out.sort(key=lambda ev: ev["at"])  # stable: same-time events keep generation order
        return out

    # --- summaries

    def population_summary(self) -> dict:
        hh = [h for z in self.pops for h in z.households]
        return {"households": len(hh), "app_households": sum(h.has_app for h in hh),
                "carless_households": sum(h.vehicles == 0 for h in hh),
                "staying_households": sum(h.stays for h in hh),
                "vehicles": sum(h.vehicles for h in hh), "zones": len(self.pops)}

    def rates(self) -> dict:
        """Latent (all-household) help rates next to the Camp record; a sanity comparison, not a fit."""
        def per(n, h):
            return None if h <= 0 else round(n / h, 4)
        return {
            "exposure_household_h": {k: round(v, 2) for k, v in self.exposure_h.items()},
            "latent_help": dict(self.latent_help),
            "latent_help_per_household_h": {k: per(self.latent_help[k], self.exposure_h[k]) for k in self.latent_help},
            "fire_zone_khh_h": round(self.fire_zone_khh_h, 3),
            "fire_zone_latent_help_per_khh_h": per(self.fire_zone_latent_help, self.fire_zone_khh_h),
            "camp_record_reference_per_khh_h": {
                "rescue_k1": CAMP_RESCUE_RATE_FIRE_IN_ZONE_PER_KHH_H,
                "nist_911_sample": CAMP_911_RATE_FIRE_IN_ZONE_PER_KHH_H,
                "nist_911_scaled_lower_bound": round(CAMP_911_RATE_FIRE_IN_ZONE_PER_KHH_H * CAMP_911_SAMPLE_SCALE_MIN, 2),
                "source": "docs/ground-data-calibration.md section 2 (fire_in_zone, order 0-2 h)",
            },
        }


# ---------------------------------------------------------------- invariants


def check_invariants(events: list[dict], pops: list[ZonePopulation]) -> None:
    """Raise AssertionError on any broken invariant: labels, shapes, causality, conservation, help after out."""
    by_party = {h.party_key: h for z in pops for h in z.households}
    hh_per_zone = {z.zone_id: len(z.households) for z in pops}
    outs: dict[str, str] = {}
    checkin_parties: set[str] = set()
    out_per_zone: dict[str, int] = {}
    last_at = ""
    for ev in events:
        if ev["evidence_class"] != EVIDENCE_CLASS:
            raise AssertionError("event not labelled simulated")
        h = by_party.get(ev["party_key"])
        if h is None or h.zone_id != ev["zone_id"]:
            raise AssertionError(f"unknown party {ev['party_key']}")
        if not h.has_app:
            raise AssertionError("an event from a household without the app")
        validate_body(ev)
        if ev["at"] < last_at:
            raise AssertionError("events out of time order")
        last_at = ev["at"]
        if ev["cause"]["at"] > ev["at"]:
            raise AssertionError(f"event before its cause: {ev['cause']} > {ev['at']}")
        if ev["type"] == "checkin":
            checkin_parties.add(h.party_key)
            status = ev["body"]["status"]
            if status == "out":
                if h.party_key in outs:
                    raise AssertionError(f"second out for {h.party_key}")
                if h.vehicles == 0:
                    raise AssertionError("carless household checked in out")
                outs[h.party_key] = ev["at"]
                out_per_zone[h.zone_id] = out_per_zone.get(h.zone_id, 0) + 1
            elif status == "need_help" and h.party_key in outs:
                raise AssertionError(f"help after out for {h.party_key}")
    if len(checkin_parties) > len(by_party):
        raise AssertionError("more checking-in parties than households")
    for z, n in out_per_zone.items():
        if n > hh_per_zone[z]:
            raise AssertionError(f"zone {z}: {n} out check-ins for {hh_per_zone[z]} households")


# ---------------------------------------------------------------- driver


CAMP_PACKAGE = "data/incidents/camp-2018-paradise-slice/a6d2cc03f525ed65"
CAMP_ROADS_PACKAGE = "data/incidents/camp-2018-evacuation/17e67cfe5669fe50"
"""The packages the live drill's twin and app/public/replays/camp-2018.json use
(app/backend/api/live/twin_service.py CAMP_PACKAGE, CAMP_ROADS_PACKAGE)."""


def camp_twin(start_at: str, root: str = "."):
    """A Camp twin as the live drill builds it (needs the package artifacts locally or MONGODB_URI)."""
    from pathlib import Path

    from sim.twin import Twin
    r = Path(root)
    return Twin.for_camp(str(r / CAMP_PACKAGE), str(r / CAMP_ROADS_PACKAGE), start_at=start_at)


def run_residents(twin, until: str, params: ResidentParams | None = None, *, every_s: int = OBSERVE_EVERY_S,
                  incident_id: str | None = None, offered=None, board=None) -> dict:
    """Step `twin` from its `now` to `until` every `every_s` simulated seconds, observing residents after
    each step. Returns events (time-ordered, invariants checked) with summary, rates and provenance."""
    if not isinstance(every_s, int) or every_s <= 0:
        raise ValueError("every_s must be a positive integer")
    gen = ResidentGenerator(twin, params, incident_id=incident_id, offered=offered, board=board)
    start = twin.now
    until_dt = parse_utc(until)
    events = gen.observe()  # baseline: states already present at the start
    while not twin.finished and parse_utc(twin.now) < until_dt:
        nxt = min(parse_utc(twin.now) + timedelta(seconds=every_s), until_dt)
        twin.step_to(format_utc(nxt))
        events.extend(gen.observe())
    check_invariants(events, gen.pops)
    counts: dict[str, int] = {}
    for ev in events:
        key = ev["type"] + ":" + (ev["body"].get("kind") or ev["body"].get("status") or "choice")
        counts[key] = counts.get(key, 0) + 1
    return {
        "kind": "crisistwin_simulated_residents", "evidence_class": EVIDENCE_CLASS,
        "generator": {"id": GENERATOR_ID, "version": GENERATOR_VERSION},
        "params": gen.p.to_dict(), "window": {"from": start, "until": twin.now, "every_s": every_s},
        "twin": {"session": twin.session_id, "inputs_fingerprint": twin.inputs.fingerprint,
                 "action_log_hash": twin.action_log_hash()},
        "population": gen.population_summary(), "counts": dict(sorted(counts.items())),
        "rates": gen.rates(), "assumptions": ASSUMPTIONS, "limitations": LIMITATIONS, "events": events,
    }


def main(argv=None) -> int:
    import argparse
    import json
    import sys
    ap = argparse.ArgumentParser(description="Simulated residents on the Camp twin (planning experiment).")
    ap.add_argument("--from", dest="start", default="2018-11-08T15:00:00Z")
    ap.add_argument("--until", default="2018-11-08T18:00:00Z")
    ap.add_argument("--seed", type=int, default=ResidentParams.seed)
    ap.add_argument("--root", default=".")
    ap.add_argument("--out", help="write the full JSON here; stdout gets the summary")
    a = ap.parse_args(argv)
    result = run_residents(camp_twin(a.start, a.root), a.until, ResidentParams(seed=a.seed))
    if a.out:
        with open(a.out, "w") as f:
            json.dump(result, f, indent=1)
    json.dump({k: v for k, v in result.items() if k not in ("events", "assumptions", "limitations")}, sys.stdout,
              indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
