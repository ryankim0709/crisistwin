"""Simulated people ("virtual phones") of the live drill: the pure part (docs/app-integration.md "Simulated people").

A simulated person is one synthetic household with the drill app. Its behaviour is drawn once from published
evidence (``sim.behavior.draw_household_choices``, profile ``grounded``; the API layer draws it and passes the
result here as a plain dict), and it lives on the drill clock, one drill minute at a time (``step``):

- it notices the fire (smoke within ``AWARE_FIRE_M`` of home, or any guidance for its zone), sees the zone's
  published guidance like a phone does, and decides per its draws, not 100% obediently: some leave before any
  warning, some wait until they see fire, some stay, some go back for a pet first, some take another offered
  road, and households with no car or who need assistance ask for help;
- once it leaves, its position is estimated along the published route of the destination it picked (from its
  home point to the route's start, then along the route line), and its progress comes from the traffic twin's
  state of its zone: the share of the zone's en-route vehicles that are moving, queued, in a long queue or
  blocked. Its fixed rank in the zone (``rank``) says which of those it is, so the zone's individuals add up to
  the twin's shares. Positions are estimates, never observations.

Everything a person does that a phone would send (check-ins, reports, destination choices) goes into
``state["outbox"]`` as an event; the API layer sends it through the same view functions the phone endpoints use.

No Django, PyMongo or network here. Times are timezone-aware UTC drill times (``t``) unless named ``wall``.
Coordinates are ``[lon, lat]``; distances meters; durations minutes where the name ends in ``_min``.
Randomness is seeded per (seed, person, draw), like ``sim.behavior``.
"""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .geo import LonLat, MultiPolygon, centroid, haversine_m, point_in_multipolygon, polyline_distance_m

AWARE_FIRE_M = 8000.0
"""ASSUMPTION: a household notices the fire (smoke, flames, word of mouth) once the fire estimate is within this
distance of home. Same value as the planner's be-ready distance (``livecore.planner.BE_READY_KM``)."""
FIRE_CUE_M = 2000.0
"""ASSUMPTION reused from ``sim.behavior.BehaviorParams.fire_cue_distance_m``: fire this close to home is the
"saw the fire" cue that wait-and-see households and shadow evacuees act on."""
IN_DANGER_M = 500.0
"""ASSUMPTION: a person not yet out within this distance of the fire estimate (or inside it) is flagged In danger."""
LATE_AFTER_MIN = 60
"""ASSUMPTION: still home this long after an evacuate-now order (and not staying on purpose) is flagged Late."""
TRIP_MAX_MIN = 20.0
"""ASSUMPTION: a trip before leaving (a pet, family, belongings) takes the last 20 min of the drawn delay (or the
whole delay when shorter). The survey delay already includes trips (``sim.behavior``)."""
MILLING_SHARE_OF_DELAY = 0.3
"""ASSUMPTION: households that sought more information spend the first 30% of their delay doing so."""
HOME_TO_ROUTE_KPH = 30.0
"""ASSUMPTION: speed from the home point to the start of the zone's route (local streets)."""
FALLBACK_KPH = 40.0
FALLBACK_DETOUR = 1.3
"""ASSUMPTION: with no published route (leaving before any guidance), a person heads for the nearest exit at
40 km/h over 1.3 x the straight-line distance."""
QUEUED_SPEED_FACTOR = 0.5
"""Share of free-flow speed while queued: ``sim.traffic.CONGESTED_SPEED_FRACTION``."""
LONG_QUEUE_SPEED_FACTOR = 0.1
"""ASSUMPTION: a vehicle in a long queue (15+ min on one edge in the twin) still creeps forward."""
REROUTE_AFTER_STUCK_MIN = 10
"""ASSUMPTION: a household that reroutes in congestion (``reroutes_in_congestion``) does so after 10 min stuck."""
OUT_CHECKIN_SHARE = 0.8
OUT_CHECKIN_LAG_MEDIAN_MIN, OUT_CHECKIN_LAG_SIGMA, OUT_CHECKIN_LAG_MAX_MIN = 5.0, 0.8, 60.0
"""ASSUMPTIONS, the same values as ``sim/gen_residents.py`` (OUT_CHECKIN_*): 80% check in `out` after arriving,
lognormal lag median 5 min."""
STAY_CHECKIN_LAG_MIN = (2.0, 15.0)
"""ASSUMPTION: a household that stays tells the app so 2-15 min (uniform) after its order or fire cue."""
HELP_REQUEST_PER_H = 2.0
"""ASSUMPTION, the rate ``sim/gen_residents.py`` uses for transport requests: once ordered or once fire is close, a
household that asks for help does so at 2.0/h (mean 30 min)."""
PICKUP_TO_OUT_MIN = 30
"""ASSUMPTION: after the controller resolves a help request, the person is out 30 min later."""
REPORT_FIRE_SHARE = 0.3
"""ASSUMPTION: share of persons who send a `fire_seen` report when fire comes within FIRE_CUE_M of home."""
REPORT_TRAFFIC_SHARE = 0.5
"""ASSUMPTION: share of persons who send a `heavy_traffic` report the first time they are slowed or stuck."""
DIFFERENT_ROAD_SHARE = 0.4
"""ASSUMPTION: share of households with a familiar route (``route_strategy: familiar``) that pick another offered
destination than the recommended one when one exists. Navigation users and those following others take the
recommended one."""

FLAGS = ("Stuck", "Needs help", "Late", "Different road", "Went back", "Not leaving", "In danger", "Toward fire")
"""Flag vocabulary, in display order."""
STAYING_ACTIONS = frozenset({"stay_and_defend", "shelter_in_place"})
TRIP_TEXT = {"pet": "Went back for a pet", "family": "Picking up family", "others": "Helping neighbours",
             "supplies": "Went back for belongings"}
PHASES = ("home", "packing", "trip", "en_route", "out", "staying", "help", "picked_up")


# ---- inputs for one drill minute ----------------------------------------------------------------------------


@dataclass(frozen=True)
class RouteOption:
    """One destination the zone's guidance offers, with its route (the recommended one first)."""

    destination_id: str
    name: str
    line: tuple[LonLat, ...]
    eta_min: float
    safety: str | None
    recommended: bool


@dataclass(frozen=True)
class GuidanceView:
    """What a phone in the zone sees: the published level and the offered destinations."""

    level: str  # evacuate_now | be_ready | none
    version: int
    options: tuple[RouteOption, ...] = ()


@dataclass(frozen=True)
class ZoneMotion:
    """The traffic twin's en-route vehicles of one zone by state (simulated). ``blocked``: on a closed edge, cut
    off by fire, no route or turned back; ``long_queue``: 15+ min on one edge; ``queued``: shorter waits."""

    en_route: int
    moving: int
    queued: int
    long_queue: int
    blocked: int


@dataclass(frozen=True)
class MinuteContext:
    t: datetime
    guidance: GuidanceView | None
    home_fire_m: float | None
    """Distance from home to the fire estimate (0 inside), None when farther than AWARE_FIRE_M or no fire."""
    motion: ZoneMotion | None
    """None when the twin is not available: en-route persons then move at free-flow speed."""
    help_status: str | None
    """Status of the person's help request on the server (open, acknowledged, assigned, resolved) or None."""
    fallback: tuple[str, str, LonLat] | None
    """(id, name, coord) of the exit nearest home, for persons who leave with no route offered."""


# ---- drawing a person -----------------------------------------------------------------------------------------


def _rng(seed: int, key: str, what: str) -> random.Random:
    """An independent stream per (seed, person key, draw). CPython seeds a str with SHA-512, so it is stable."""
    return random.Random(f"{seed}:virtual-person:{key}:{what}")


def pick_zone(seed: int, n: int, zones: Sequence[tuple[str, int]]) -> str:
    """The zone of person ``n``: a draw in proportion to the zones' households (sorted by id, so the draw does
    not depend on the input order). Independent per person, so adding people never moves earlier ones."""
    rows = sorted((zid, max(0, int(h))) for zid, h in zones)
    if not rows or sum(h for _, h in rows) <= 0:
        raise ValueError("no zone has households")
    return _rng(seed, str(n), "zone").choices([z for z, _ in rows], weights=[h for _, h in rows])[0]


def home_point(seed: int, key: str, geometry: MultiPolygon) -> LonLat:
    """A seeded point inside the zone (uniform in the bounding box, kept when inside); the centroid after 500
    misses. An estimated home, not an address."""
    rng = _rng(seed, key, "home")
    xs = [p[0] for poly in geometry for p in poly[0]]
    ys = [p[1] for poly in geometry for p in poly[0]]
    for _ in range(500):
        p = (rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys)))
        if point_in_multipolygon(p, geometry):
            return (round(p[0], 5), round(p[1], 5))
    c = centroid(geometry)
    return (round(c[0], 5), round(c[1], 5))


def draw_extras(seed: int, key: str) -> dict[str, Any]:
    """The person's draws that ``sim.behavior`` does not make (see the constants above for each assumption)."""
    lag = _rng(seed, key, "out_lag").lognormvariate(math.log(OUT_CHECKIN_LAG_MEDIAN_MIN), OUT_CHECKIN_LAG_SIGMA)
    return {
        "rank": round(_rng(seed, key, "rank").random(), 6),
        "out_checkin": _rng(seed, key, "out_checkin").random() < OUT_CHECKIN_SHARE,
        "out_lag_min": round(min(OUT_CHECKIN_LAG_MAX_MIN, lag), 2),
        "stay_lag_min": round(_rng(seed, key, "stay_lag").uniform(*STAY_CHECKIN_LAG_MIN), 2),
        "help_lag_min": round(_rng(seed, key, "help_lag").expovariate(HELP_REQUEST_PER_H / 60.0), 2),
        "report_fire": _rng(seed, key, "report_fire").random() < REPORT_FIRE_SHARE,
        "report_traffic": _rng(seed, key, "report_traffic").random() < REPORT_TRAFFIC_SHARE,
        "different_road": _rng(seed, key, "different_road").random() < DIFFERENT_ROAD_SHARE,
    }


def initial_state(home: LonLat) -> dict[str, Any]:
    return {
        "phase": "home", "aware_at": None, "ordered_at": None, "cue_at": None, "decided_at": None,
        "trigger_at": None, "depart_at": None, "trip_from": None, "arrived_at": None, "picked_at": None,
        "dest_id": None, "dest_name": None, "recommended_id": None, "different_road": False, "route_safety": None,
        "path": None, "total_min": None, "progress": 0.0, "motion": None, "stuck_since": None,
        "position": [home[0], home[1]], "home_fire_m": None, "done": [], "outbox": [], "ticked_to": None,
    }


# ---- one drill minute -----------------------------------------------------------------------------------------


def _minutes(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 60.0


def _emit(state: dict[str, Any], key: str, event: dict[str, Any]) -> None:
    """Queue an event once per key (a check-in, report or destination choice the phone would send)."""
    if key in state["done"]:
        return
    state["done"].append(key)
    state["outbox"].append({"key": key, **event})


def _path_length(path: Sequence[Sequence[float]]) -> float:
    return sum(haversine_m(tuple(a), tuple(b)) for a, b in zip(path, path[1:]))


def point_along(path: Sequence[Sequence[float]], fraction: float) -> list[float]:
    """The point at ``fraction`` (0..1) of the path's length, ``[lon, lat]`` rounded to 5 decimals."""
    if not path:
        raise ValueError("empty path")
    total = _path_length(path)
    target = min(1.0, max(0.0, fraction)) * total
    walked = 0.0
    for a, b in zip(path, path[1:]):
        d = haversine_m(tuple(a), tuple(b))
        if walked + d >= target and d > 0:
            f = (target - walked) / d
            return [round(a[0] + (b[0] - a[0]) * f, 5), round(a[1] + (b[1] - a[1]) * f, 5)]
        walked += d
    return [round(path[-1][0], 5), round(path[-1][1], 5)]


def _route_from(start: Sequence[float], option: RouteOption) -> tuple[list[list[float]], float]:
    """Path (start, then the route line) and its free-flow minutes: the route's ETA plus the leg to its start."""
    line = [list(p) for p in option.line]
    if not line:
        return [list(start)], 0.0
    leg_min = haversine_m(tuple(start), tuple(line[0])) / 1000.0 / HOME_TO_ROUTE_KPH * 60.0
    return [list(start), *line], max(1.0, float(option.eta_min) + leg_min)


def _rest_of_route(pos: Sequence[float], option: RouteOption) -> tuple[list[list[float]], float]:
    """A reroute from where the person is: join the new route at its point nearest to them."""
    line = list(option.line)
    if not line:
        return [list(pos)], 0.0
    k = min(range(len(line)), key=lambda i: haversine_m(tuple(pos), line[i]))
    rest = RouteOption(option.destination_id, option.name, tuple(line[k:]),
                       option.eta_min * (1.0 - k / max(1, len(line) - 1)), option.safety, option.recommended)
    return _route_from(pos, rest)


def _trigger_time(spec: Mapping[str, Any], state: Mapping[str, Any]) -> datetime | None:
    """When the household's drawn trigger fires (``departure_trigger``); None while it has not."""
    trig = spec["choices"]["departure_trigger"]
    if trig == "before_warning":
        cands = [state["aware_at"]]
    elif trig == "warning":
        cands = [state["ordered_at"], state["cue_at"] if spec["shadow_leaves"] else None]
    elif trig == "fire_cue":
        cands = [state["cue_at"]]
    else:
        return None
    cands = [c for c in cands if c is not None]
    return min(cands) if cands else None


def _depart(spec: Mapping[str, Any], state: dict[str, Any], ctx: MinuteContext) -> None:
    g = ctx.guidance
    options = g.options if g is not None and g.level != "none" else ()
    home = spec["home"]
    state["phase"] = "en_route"
    state["progress"] = 0.0
    if options:
        rec = next((o for o in options if o.recommended), options[0])
        chosen = rec
        others = [o for o in options if o.destination_id != rec.destination_id]
        if spec["choices"].get("route_strategy") == "familiar" and spec["draws"]["different_road"] and others:
            chosen = others[0]
        state["path"], state["total_min"] = _route_from(home, chosen)
        state.update(dest_id=chosen.destination_id, dest_name=chosen.name, recommended_id=rec.destination_id,
                     different_road=chosen.destination_id != rec.destination_id, route_safety=chosen.safety)
        _emit(state, f"dest:{chosen.destination_id}", {"type": "destination", "at": ctx.t,
                                                       "destination_id": chosen.destination_id})
    elif ctx.fallback is not None:
        dest_id, name, coord = ctx.fallback
        dist_m = haversine_m(tuple(home), coord)
        state["path"] = [list(home), [coord[0], coord[1]]]
        state["total_min"] = max(1.0, dist_m * FALLBACK_DETOUR / 1000.0 / FALLBACK_KPH * 60.0)
        state.update(dest_id=dest_id, dest_name=name, recommended_id=None, different_road=False, route_safety=None)
    else:
        state["path"], state["total_min"] = [list(home)], 1.0


def _move(spec: Mapping[str, Any], state: dict[str, Any], ctx: MinuteContext) -> None:
    m, u = ctx.motion, spec["draws"]["rank"]
    motion, factor = "driving", 1.0
    if m is not None and m.en_route > 0:
        cuts = ((m.blocked, "blocked", 0.0), (m.long_queue, "long_queue", LONG_QUEUE_SPEED_FACTOR),
                (m.queued, "queued", QUEUED_SPEED_FACTOR))
        edge = 0.0
        for count, name, f in cuts:
            edge += count / m.en_route
            if u < edge:
                motion, factor = name, f
                break
    state["motion"] = motion
    if motion in ("blocked", "long_queue"):
        state["stuck_since"] = state["stuck_since"] or ctx.t
    else:
        state["stuck_since"] = None
    if motion != "driving" and spec["draws"]["report_traffic"]:
        blocked = motion == "blocked"
        _emit(state, "traffic", {"type": "report", "at": ctx.t, "kind": "road_blocked" if blocked else "heavy_traffic",
                                 "severity": "full" if blocked else "slow", "coord": list(state["position"]),
                                 "note": "Road blocked ahead" if blocked else "Traffic barely moving"})
    # Reroute after being stuck a while, to another offered destination (once).
    g = ctx.guidance
    if (spec["choices"].get("reroutes_in_congestion") and state["stuck_since"] is not None
            and _minutes(state["stuck_since"], ctx.t) >= REROUTE_AFTER_STUCK_MIN and "reroute" not in state["done"]
            and g is not None and g.level != "none"):
        alt = next((o for o in g.options if o.destination_id != state["dest_id"]), None)
        if alt is not None:
            state["done"].append("reroute")
            state["path"], state["total_min"] = _rest_of_route(state["position"], alt)
            state.update(progress=0.0, dest_id=alt.destination_id, dest_name=alt.name, route_safety=alt.safety,
                         different_road=alt.destination_id != state["recommended_id"], stuck_since=None)
            _emit(state, f"dest:{alt.destination_id}", {"type": "destination", "at": ctx.t,
                                                        "destination_id": alt.destination_id})
            return
    state["progress"] = min(1.0, state["progress"] + factor / max(1.0, state["total_min"]))
    state["position"] = point_along(state["path"], state["progress"])
    if state["progress"] >= 1.0:
        state.update(phase="out", arrived_at=ctx.t, motion=None, stuck_since=None)


def step(spec: Mapping[str, Any], state: dict[str, Any], ctx: MinuteContext) -> None:
    """Advance one person by the drill minute ending at ``ctx.t`` (mutates ``state``; events go to its outbox)."""
    t, g, c = ctx.t, ctx.guidance, spec["choices"]
    level = g.level if g is not None else "none"
    fire_m = ctx.home_fire_m
    state["home_fire_m"] = fire_m
    if state["aware_at"] is None and (level in ("be_ready", "evacuate_now")
                                      or (fire_m is not None and fire_m <= AWARE_FIRE_M)):
        state["aware_at"] = t
    if state["ordered_at"] is None and level == "evacuate_now":
        state["ordered_at"] = t
    if state["cue_at"] is None and fire_m is not None and fire_m <= FIRE_CUE_M:
        state["cue_at"] = t
        if spec["draws"]["report_fire"] and state["phase"] not in ("en_route", "out", "picked_up"):
            _emit(state, "fire_seen", {"type": "report", "at": t, "kind": "fire_seen", "severity": None,
                                       "coord": list(spec["home"]), "note": "Flames visible from home"})

    decided = min((x for x in (state["ordered_at"], state["cue_at"]) if x is not None), default=None)
    if state["phase"] == "home":
        cannot_drive = not spec["has_vehicle"]
        if c["requests_help"]:
            if decided is not None and _minutes(decided, t) >= spec["draws"]["help_lag_min"]:
                state.update(phase="help", decided_at=t)
                _emit(state, "help", {"type": "checkin", "at": t, "status": "need_help", "coord": list(spec["home"])})
        elif cannot_drive or c["protective_action"] in STAYING_ACTIONS:
            if decided is not None and _minutes(decided, t) >= spec["draws"]["stay_lag_min"]:
                state.update(phase="staying", decided_at=t)
                _emit(state, "staying", {"type": "checkin", "at": t, "status": "staying"})
        else:
            trig = _trigger_time(spec, state)
            if trig is not None:
                delay = float(c["departure_delay_min"] or 0.0)
                depart = trig + timedelta(minutes=delay)
                trip_min = min(TRIP_MAX_MIN, delay) if c.get("trip_before_leaving") else 0.0
                state.update(phase="packing", trigger_at=trig, depart_at=depart,
                             trip_from=depart - timedelta(minutes=trip_min) if trip_min else None)
    if state["phase"] in ("packing", "trip"):
        if state["trip_from"] is not None and t >= state["trip_from"]:
            state["phase"] = "trip"
        if t >= state["depart_at"]:
            _depart(spec, state, ctx)
    if state["phase"] == "en_route":
        _move(spec, state, ctx)
    if state["phase"] == "help" and ctx.help_status == "resolved":
        state.update(phase="picked_up", picked_at=t)
    if state["phase"] == "picked_up" and _minutes(state["picked_at"], t) >= PICKUP_TO_OUT_MIN:
        state.update(phase="out", arrived_at=t, position=list(spec["home"]))
    if state["phase"] == "out" and spec["draws"]["out_checkin"] and \
            _minutes(state["arrived_at"], t) >= spec["draws"]["out_lag_min"]:
        _emit(state, "out", {"type": "checkin", "at": t, "status": "out"})
    state["ticked_to"] = t


# ---- what the controller sees ---------------------------------------------------------------------------------


def describe(spec: Mapping[str, Any], state: Mapping[str, Any], t: datetime,
             fire: MultiPolygon | None, help_status: str | None) -> tuple[str, list[str]]:
    """Plain-language status and flags (``FLAGS`` order) at drill time ``t``."""
    c, phase = spec["choices"], state["phase"]
    flags: set[str] = set()
    if phase == "home":
        if state["ordered_at"] is not None and c["protective_action"] == "wait_and_see" and not c["requests_help"]:
            status = "Waiting to see"
            flags.add("Not leaving")
        else:
            status = "At home"
    elif phase in ("packing", "trip"):
        if phase == "trip":
            status = TRIP_TEXT.get(c.get("trip_before_leaving") or "", "Went back home")
            flags.add("Went back")
            if state.get("home_fire_m") is not None and state["home_fire_m"] <= FIRE_CUE_M:
                flags.add("Toward fire")
        elif c.get("milling") and t < state["trigger_at"] + (state["depart_at"] - state["trigger_at"]) * MILLING_SHARE_OF_DELAY:
            status = "Checking with neighbours"
        else:
            status = "Packing"
    elif phase == "en_route":
        to_go = max(1, math.ceil((1.0 - state["progress"]) * (state["total_min"] or 1.0)))
        stuck_min = int(_minutes(state["stuck_since"], t)) if state["stuck_since"] else 0
        motion = state["motion"]
        if motion == "blocked":
            status = f"Stuck, road closed ahead, {stuck_min} min"
            flags.add("Stuck")
        elif motion == "long_queue":
            status = f"Stuck in traffic, {stuck_min} min"
            flags.add("Stuck")
        elif motion == "queued":
            status = f"Slow traffic, {to_go} min to go"
        else:
            status = f"Driving out, {to_go} min to go"
        if state["route_safety"] in ("passes_fire", "passes_near_fire"):
            flags.add("Toward fire")
    elif phase == "staying":
        status = "Staying home"
        flags.add("Not leaving")
    elif phase == "help":
        status = {"assigned": "Asked for help, responder on the way",
                  "acknowledged": "Asked for help, request seen"}.get(
            help_status or "", "Asked for help, no car" if not spec["has_vehicle"] else "Asked for help")
        flags.add("Needs help")
    elif phase == "picked_up":
        status = "Picked up by responders"
    else:
        status = "Safely out"
    if phase in ("en_route", "out") and state["different_road"]:
        flags.add("Different road")
    if (phase in ("home", "packing", "trip") and state["ordered_at"] is not None
            and _minutes(state["ordered_at"], t) >= LATE_AFTER_MIN and c["protective_action"] not in STAYING_ACTIONS
            and not c["requests_help"]):
        flags.add("Late")
    if phase not in ("out", "picked_up") and fire:
        if polyline_distance_m([tuple(state["position"])], fire, IN_DANGER_M) <= IN_DANGER_M:
            flags.add("In danger")
    return status, [f for f in FLAGS if f in flags]


def home_fire_distance(home: LonLat, fire: MultiPolygon | None) -> float | None:
    """Meters from home to the fire estimate (0 inside); None when no fire or farther than AWARE_FIRE_M."""
    if not fire:
        return None
    d = polyline_distance_m([tuple(home)], fire, AWARE_FIRE_M)
    return None if math.isinf(d) else round(d, 1)
