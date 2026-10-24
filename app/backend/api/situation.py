"""The dispatcher's situation as a fixed-length numeric vector, for Atlas Vector Search.

Built only from simulator figures in the observation (contracts.ts `Observation`): how much of
the area the fire threatens, how far the evacuation has got, how little time unordered zones
have, the fires, the wind and the roads lost. Each feature is scaled to [0, 1] and then centred
to [-1, 1], so cosine similarity compares the shape of two situations, not their size. Pure: no
database or network. See docs/adr/0032-atlas-situation-search.md.
"""

import math

# Feature order is the vector layout; change VERSION whenever it changes (old vectors are then
# ignored by the search filter).
VERSION = 1
FEATURES = (
    "fire_path_share",  # households in the fire path / all households
    "not_ordered_share",  # households with no order / households in the fire path
    "waiting_share",  # ordered households still home or queued / households in the fire path
    "en_route_share",
    "out_share",
    "exposed_share",
    "threatened_zone_share",  # zones burning or threatened / zones in the fire path
    "unordered_threatened_share",  # of those, without an order or staging
    "tightest_slack",  # smallest order slack of an unaddressed zone, -30..60 min -> 0..1
    "urgent_zone_share",  # unaddressed zones with slack <= 10 min / zones in the fire path
    "burning_fires",  # burning fires / 5
    "burned_area",  # log scale up to 5,000 ha
    "crowning",  # any burning fire crowning
    "wind_speed",  # mph / 40
    "wind_from_sin",
    "wind_from_cos",
    "planner_closures",  # / 10
    "fire_cut_roads",  # road segments the fire cut, log scale up to 200
    "route_blocked_share",  # ordered zones whose route is cut / ordered zones
    "units_available_share",
    "clock",  # minute / horizon
)
DIMENSIONS = len(FEATURES)

SLACK_FLOOR_MIN = -30
SLACK_CEIL_MIN = 60
URGENT_SLACK_MIN = 10
MAX_FIRES = 5
MAX_AREA_HA = 5000
MAX_WIND_MPH = 40
MAX_CLOSURES = 10
MAX_CUT_SEGMENTS = 200
ACTIVE_IMPACT = {"burning", "threatened"}


def _num(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return default
    return float(value)


def _share(part: float, whole: float) -> float:
    return min(1.0, max(0.0, part / whole)) if whole > 0 else 0.0


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def _log_scale(value: float, ceiling: float) -> float:
    return _clamp(math.log1p(max(0.0, value)) / math.log1p(ceiling))


def features(obs: dict) -> dict[str, float]:
    """Named features in [0, 1] (readable; stored next to the vector)."""
    totals = obs.get("totals") if isinstance(obs.get("totals"), dict) else {}
    fire = obs.get("fire") if isinstance(obs.get("fire"), dict) else {}
    clock = obs.get("clock") if isinstance(obs.get("clock"), dict) else {}
    roads = obs.get("roads") if isinstance(obs.get("roads"), dict) else {}
    zones = [z for z in obs.get("zones") or [] if isinstance(z, dict)]
    fires = [f for f in obs.get("fires") or [] if isinstance(f, dict)]
    units = [u for u in obs.get("units") or [] if isinstance(u, dict)]

    homes = _num(totals.get("homes"))
    path = fire.get("fire_path") if isinstance(fire.get("fire_path"), dict) else {}
    path_homes = _num(path.get("homes"), homes)
    in_path = [z for z in zones if z.get("impact") != "outside"]
    active = [z for z in in_path if z.get("impact") in ACTIVE_IMPACT]
    unaddressed = [z for z in in_path if z.get("status") == "no_order" and not z.get("staged_after")]
    slacks = [_num(z.get("order_slack_min")) for z in unaddressed if z.get("order_slack_min") is not None]
    ordered = [z for z in zones if z.get("status") == "ordered"]
    burning = [f for f in fires if f.get("status") == "burning"]
    wind_from = math.radians(_num(fire.get("wind_from_degrees")))
    closed = roads.get("planner_closed") if isinstance(roads.get("planner_closed"), list) else []
    tightest = min(slacks) if slacks else SLACK_CEIL_MIN

    return {
        "fire_path_share": _share(path_homes, homes),
        "not_ordered_share": _share(_num(totals.get("not_ordered")) - (homes - path_homes), path_homes),
        "waiting_share": _share(_num(totals.get("waiting")), path_homes),
        "en_route_share": _share(_num(totals.get("en_route")), path_homes),
        "out_share": _share(_num(totals.get("out")), path_homes),
        "exposed_share": _share(_num(totals.get("exposed")), path_homes),
        "threatened_zone_share": _share(len(active), len(in_path)),
        "unordered_threatened_share": _share(len([z for z in active if z in unaddressed]), len(active)),
        "tightest_slack": _clamp((tightest - SLACK_FLOOR_MIN) / (SLACK_CEIL_MIN - SLACK_FLOOR_MIN)),
        "urgent_zone_share": _share(len([s for s in slacks if s <= URGENT_SLACK_MIN]), len(in_path)),
        "burning_fires": _clamp(len(burning) / MAX_FIRES),
        "burned_area": _log_scale(_num(fire.get("burned_area_ha")), MAX_AREA_HA),
        "crowning": 1.0 if any(f.get("crowning") for f in burning) else 0.0,
        "wind_speed": _clamp(_num(fire.get("wind_speed_mph")) / MAX_WIND_MPH),
        "wind_from_sin": (math.sin(wind_from) + 1) / 2,
        "wind_from_cos": (math.cos(wind_from) + 1) / 2,
        "planner_closures": _clamp(len(closed) / MAX_CLOSURES),
        "fire_cut_roads": _log_scale(_num(roads.get("fire_cut_segments")), MAX_CUT_SEGMENTS),
        "route_blocked_share": _share(len([z for z in ordered if z.get("route_blocked")]), len(ordered)),
        "units_available_share": _share(len([u for u in units if u.get("status") == "available"]), len(units)),
        "clock": _share(_num(clock.get("minute")), _num(clock.get("horizon_minutes"))),
    }


def vector(named: dict[str, float]) -> list[float]:
    """Centred to [-1, 1] in FEATURES order, rounded for storage."""
    return [round(2 * named[name] - 1, 4) for name in FEATURES]


def summary(obs: dict) -> dict:
    """The same situation in the observation's own units, for the agent to read."""
    named = features(obs)
    fire = obs.get("fire") if isinstance(obs.get("fire"), dict) else {}
    clock = obs.get("clock") if isinstance(obs.get("clock"), dict) else {}
    roads = obs.get("roads") if isinstance(obs.get("roads"), dict) else {}
    zones = [z for z in obs.get("zones") or [] if isinstance(z, dict)]
    slacks = [
        _num(z.get("order_slack_min"))
        for z in zones
        if z.get("status") == "no_order"
        and not z.get("staged_after")
        and z.get("impact") != "outside"
        and z.get("order_slack_min") is not None
    ]
    pct = {name: round(100 * named[name]) for name in FEATURES if name.endswith("_share")}
    closed = roads.get("planner_closed") if isinstance(roads.get("planner_closed"), list) else []
    return {
        "minute": clock.get("minute"),
        "percent": pct,
        "tightest_unordered_slack_min": round(min(slacks)) if slacks else None,
        "burning_fires": round(named["burning_fires"] * MAX_FIRES),
        "burned_area_ha": fire.get("burned_area_ha"),
        "crowning": named["crowning"] == 1.0,
        "wind_from_degrees": fire.get("wind_from_degrees"),
        "wind_speed_mph": fire.get("wind_speed_mph"),
        "planner_closed_roads": len(closed),
        "fire_cut_segments": roads.get("fire_cut_segments", 0),
    }
