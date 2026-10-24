"""Rule-based responder agents for the agent-simulation mode (`simulate`), never the historical replay.

Each agent is a small deterministic controller called by `simulate_traffic(controllers=...)`
with the simulation time and a read-only `TrafficView`; it returns new `TrafficEvent`s
(contraflow, closures, evacuation orders). Thresholds, cooldowns and resources are named
constants and every agent's `describe()` returns them for the output's assumptions.
Every event an agent creates is `evidence_class: "simulated"` with source RESPONDER_SOURCE_ID.

Agents know the modelled fire through `fire_lookup(lon, lat) -> datetime | None`, the
modelled arrival time at a point. They act on arrivals within their lead time, which is a
perfect short-range forecast of the fire model, not of the real 2018 fire.

`compare_with_history` matches each responder action to the nearest historical action of
the same kind on the same road (e.g. NIST TN 2252 Table A-2 contraflow and closures).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sim.events import (
    CONTRAFLOW_EXTENT_M, TOWN_REFERENCE_LONLAT, _exit_time_s, _Geo, canonical_road_name,
)
from sim.history import format_utc
from sim.traffic import DemandZone, Destination, RoadEdge, RoadNetwork, TrafficEvent, TrafficView

RESPONDER_SOURCE_ID = "responder-agent"
LABEL_PREFIX = "Responder agent (simulated)"
LOCAL_TZ = ZoneInfo("America/Los_Angeles")  # incident local time, for comparison text only

FireLookup = Callable[[float, float], "datetime | None"]

# --- CHP traffic control
# Main egress corridors out of Paradise, named as in the CHP contraflow entry of NIST Table A-2
# ("Clark Rd, Pentz Rd, and Skyway"). Edges are selected as sim.events does for a contraflow
# without a source point: the named road within CONTRAFLOW_EXTENT_M of TOWN_REFERENCE_LONLAT,
# outbound = toward the nearest exit by free-flow time.
CAMP_EGRESS_CORRIDORS = (("Skyway", "skyway"), ("Clark Road", "clark"), ("Pentz Road", "pentz"))
CHP_CHECK_EVERY_S = 60
CHP_UNITS = 2  # corridors CHP can staff at once; a staffed corridor holds inbound, then may contraflow
CHP_CONTRAFLOW_SPEED_RATIO = 0.4  # vehicle-weighted mean speed / free-flow speed on the corridor
CHP_CONTRAFLOW_SUSTAIN_S = 10 * 60  # ratio must stay below the threshold this long
CHP_CONTRAFLOW_MIN_VEH = 50  # ignore a "slow" corridor carrying fewer vehicles than this
CHP_CONTRAFLOW_FIRE_KM = 6.0  # modelled fire within this distance of the town reference
CHP_HOLD_FIRE_KM = 10.0  # inbound hold once modelled fire is within this distance of town
CHP_COOLDOWN_S = 5 * 60  # minimum time between two CHP actions (one decision per unit dispatch)
TOWN_FIRE_PROBE_M = 500.0  # town proximity is probed at network nodes on this spacing

# --- Fire road closure
FIRE_CLOSURE_LEAD_S = 15 * 60  # close a road when modelled fire reaches it within this lead
FIRE_CLOSURE_CHECK_EVERY_S = 5 * 60
FIRE_CLOSURE_MAX_ROADS_PER_CHECK = 3  # crews: named roads closed per check
FIRE_CLOSURE_HIGHWAYS = ("trunk", "primary", "secondary", "tertiary")  # roads officers post closures on

# --- Evacuation officer
ORDER_LEAD_S = 90 * 60  # order a zone whose modelled fire arrival is within this lead
ORDER_DISPATCH_INTERVAL_S = 5 * 60  # at most one zone order per interval

ASSUMPTIONS = [
    "Responder agents are rule-based controllers of the agent simulation, not historical actions; "
    "their events are simulated and appear only in agent-simulation output.",
    "Agents act from the modelled fire's first arrival on the network and see modelled fire arrival times within "
    "their lead time (perfect short-range forecast of the simulated fire), and current modelled traffic.",
    "Comparison with history matches action kind and canonical road name only; locations along the road "
    "and the 2018 decision process are not compared.",
]


def fire_arrival_lookup(grid, arrival_s: list[float], t0: datetime) -> FireLookup:
    """`fire_lookup` over a fire arrival grid (sim.fire.simulate_arrival output)."""

    def lookup(lon: float, lat: float) -> datetime | None:
        cell = grid.cell_of(lon, lat)
        if cell is None or not math.isfinite(arrival_s[cell]):
            return None
        return t0 + timedelta(seconds=arrival_s[cell])

    return lookup


def _event(agent: str, n: int, at: datetime, ev_type: str, text: str, *, edge_ids=(), zone_ids=(),
           closure_drains: bool = False) -> TrafficEvent:
    return TrafficEvent(
        id=f"responder-{agent}-{n}",
        at=at,
        type=ev_type,
        label=f"{LABEL_PREFIX}: {text}",
        evidence_class="simulated",
        time_precision="model_step",
        edge_ids=tuple(edge_ids),
        zone_ids=tuple(zone_ids),
        source_id=RESPONDER_SOURCE_ID,
        source_locator=agent,
        closure_drains=closure_drains,
    )


def _edge_point(edge: RoadEdge) -> tuple[float, float]:
    return edge.coords[len(edge.coords) // 2] if edge.coords else (math.nan, math.nan)


@dataclass
class _Corridor:
    name: str
    outbound: list[str]  # edge ids, outbound direction
    inbound_entry: list[str]  # inbound edges at the outer end of the corridor, closed by a hold
    state: str = "none"  # none | hold | contraflow
    slow_since: datetime | None = None


def egress_corridors(network: RoadNetwork, exits: Sequence[Destination],
                     corridors=CAMP_EGRESS_CORRIDORS) -> list[_Corridor]:
    """Corridors as CHP staffs them: (display name, canonical key) -> outbound edges and the hold edges.

    Edges are the named road within CONTRAFLOW_EXTENT_M of TOWN_REFERENCE_LONLAT; outbound means toward
    the nearest exit by free-flow time. Corridors with no outbound edge are left out.
    """
    geo = _Geo(network)
    exit_time = _exit_time_s(network, tuple(exits))
    out_corridors: list[_Corridor] = []
    for display, key in corridors:
        named = [e for e in network.edges if canonical_road_name(e.name) == key
                 and geo.dist_to_line(TOWN_REFERENCE_LONLAT, e.coords) <= CONTRAFLOW_EXTENT_M]
        out = [e for e in named if exit_time.get(e.to_node, math.inf) < exit_time.get(e.from_node, math.inf)]
        inbound = [e for e in named if e not in out]
        if not out:
            continue
        # Hold point: the inbound edge farthest from town, i.e. where inbound traffic enters the corridor.
        far = max(geo.dist(_edge_point(e), TOWN_REFERENCE_LONLAT) for e in inbound) if inbound else None
        entry = [e.id for e in inbound if geo.dist(_edge_point(e), TOWN_REFERENCE_LONLAT) == far]
        out_corridors.append(_Corridor(display, sorted(e.id for e in out), entry))
    return out_corridors


class ChpTrafficControl:
    """CHP: holds inbound traffic on staffed corridors and starts contraflow on sustained congestion."""

    name = "chp"

    def __init__(self, network: RoadNetwork, exits: Sequence[Destination], fire_lookup: FireLookup, *,
                 corridors=CAMP_EGRESS_CORRIDORS, units: int = CHP_UNITS, active_from: datetime | None = None):
        self.active_from = active_from
        geo = _Geo(network)
        self.units = units
        self.corridors: list[_Corridor] = egress_corridors(network, exits, corridors)
        # Town proximity: earliest modelled arrival at network nodes within each probe distance.
        self._town_fire_at: dict[float, datetime | None] = {}
        for km in (CHP_HOLD_FIRE_KM, CHP_CONTRAFLOW_FIRE_KM):
            times = [fire_lookup(*p) for n, p in sorted(network.nodes.items())
                     if geo.dist(p, TOWN_REFERENCE_LONLAT) <= km * 1000]
            times = [t for t in times if t is not None]
            self._town_fire_at[km] = min(times) if times else None
        self._last_action: datetime | None = None
        self._next_check: datetime | None = None
        self._n = 0

    def _fire_within(self, km: float, at: datetime) -> bool:
        when = self._town_fire_at[km]
        return when is not None and when <= at

    def __call__(self, at: datetime, view) -> list[TrafficEvent]:
        if self.active_from is not None and at < self.active_from:
            return []
        if self._next_check is not None and at < self._next_check:
            return []
        self._next_check = at + timedelta(seconds=CHP_CHECK_EVERY_S)
        load = {c.name: _corridor_load(view, c.outbound) for c in self.corridors}
        for c in self.corridors:
            veh, ratio = load[c.name]
            slow = veh >= CHP_CONTRAFLOW_MIN_VEH and ratio < CHP_CONTRAFLOW_SPEED_RATIO
            c.slow_since = (c.slow_since or at) if slow else None
        if self._last_action is not None and at - self._last_action < timedelta(seconds=CHP_COOLDOWN_S):
            return []
        staffed = sum(1 for c in self.corridors if c.state != "none")
        # One decision per check, most loaded corridor first.
        for c in sorted(self.corridors, key=lambda c: (-load[c.name][0], c.name)):
            sustained = c.slow_since is not None and at - c.slow_since >= timedelta(seconds=CHP_CONTRAFLOW_SUSTAIN_S)
            if c.state != "contraflow" and sustained and self._fire_within(CHP_CONTRAFLOW_FIRE_KM, at):
                events = []
                if c.state == "none" and staffed >= self.units:
                    # Contraflow outranks a hold: move the unit from the least loaded hold-only corridor.
                    donors = [d for d in self.corridors if d.state == "hold"]
                    if not donors:
                        continue
                    donor = min(donors, key=lambda d: (load[d.name][0], d.name))
                    donor.state = "none"
                    events.append(self._act(at, "road_reopened", donor.inbound_entry,
                                            f"CHP lifts the inbound hold on {donor.name} to staff {c.name}"))
                c.state = "contraflow"
                veh, ratio = load[c.name]
                events.append(self._act(at, "contraflow_started", c.outbound,
                                        f"CHP starts contraflow on {c.name} ({veh} veh at {ratio:.0%} of free-flow "
                                        f"speed for {CHP_CONTRAFLOW_SUSTAIN_S // 60}+ min)"))
                return events
            if (c.state == "none" and staffed < self.units and c.inbound_entry
                    and self._fire_within(CHP_HOLD_FIRE_KM, at) and _occupancy(view, c.inbound_entry) == 0):
                c.state = "hold"
                return [self._act(at, "road_closed", c.inbound_entry, f"CHP holds inbound traffic on {c.name}")]
        return []

    def _act(self, at: datetime, ev_type: str, edge_ids, text: str) -> TrafficEvent:
        self._n += 1
        self._last_action = at
        return _event(self.name, self._n, at, ev_type, text, edge_ids=edge_ids)

    def describe(self) -> dict:
        return {
            "agent": "ChpTrafficControl",
            "role": "CHP traffic control on main egress corridors",
            "rules": [
                f"A staffed corridor holds inbound traffic (closes its outermost inbound edge, if empty) once modelled "
                f"fire is within {CHP_HOLD_FIRE_KM:g} km of town.",
                f"Contraflow starts when the corridor carries >= {CHP_CONTRAFLOW_MIN_VEH} veh at a vehicle-weighted "
                f"mean speed below {CHP_CONTRAFLOW_SPEED_RATIO:.0%} of free-flow for {CHP_CONTRAFLOW_SUSTAIN_S // 60} "
                f"min while modelled fire is within {CHP_CONTRAFLOW_FIRE_KM:g} km of town.",
                f"At most {self.units} corridors are staffed at once; contraflow takes the unit of the least loaded "
                f"hold-only corridor when none is free (that hold is lifted); one decision per {CHP_COOLDOWN_S // 60} "
                "min; contraflow, once started, stays for the run.",
            ],
            "parameters": {
                "units": self.units, "check_every_s": CHP_CHECK_EVERY_S,
                "contraflow_speed_ratio": CHP_CONTRAFLOW_SPEED_RATIO, "contraflow_sustain_s": CHP_CONTRAFLOW_SUSTAIN_S,
                "contraflow_min_veh": CHP_CONTRAFLOW_MIN_VEH, "contraflow_fire_km": CHP_CONTRAFLOW_FIRE_KM,
                "hold_fire_km": CHP_HOLD_FIRE_KM, "cooldown_s": CHP_COOLDOWN_S,
                "corridor_extent_m": CONTRAFLOW_EXTENT_M, "town_reference_lonlat": list(TOWN_REFERENCE_LONLAT),
            },
            "corridors": [{"name": c.name, "outbound_edges": len(c.outbound), "hold_edges": c.inbound_entry}
                          for c in self.corridors],
            "town_fire_within_km_at": {f"{km:g}": format_utc(t) if t else None for km, t in self._town_fire_at.items()},
        }


class FireRoadClosure:
    """Closes major roads (both directions) shortly before the modelled fire reaches them."""

    name = "fire-closure"

    def __init__(self, network: RoadNetwork, fire_lookup: FireLookup, *, active_from: datetime | None = None):
        self.active_from = active_from
        self._edges = {e.id: e for e in network.edges}
        arrivals = []
        for e in network.edges:
            if e.highway not in FIRE_CLOSURE_HIGHWAYS:
                continue
            when = fire_lookup(*_edge_point(e))
            if when is not None:
                arrivals.append((when, e.id))
        self._arrivals = sorted(arrivals)
        self._closed: set[str] = set()
        self._next_check: datetime | None = None
        self._n = 0

    def __call__(self, at: datetime, view) -> list[TrafficEvent]:
        if self.active_from is not None and at < self.active_from:
            return []
        if self._next_check is not None and at < self._next_check:
            return []
        self._next_check = at + timedelta(seconds=FIRE_CLOSURE_CHECK_EVERY_S)
        horizon = at + timedelta(seconds=FIRE_CLOSURE_LEAD_S)
        by_road: dict[str, list[str]] = {}
        first: dict[str, datetime] = {}
        for when, edge_id in self._arrivals:
            if when > horizon:
                break
            # Already burning edges are closed by the engine's own fire closure; occupied edges are left
            # open so vehicles on them are not frozen in place.
            if when <= at or edge_id in self._closed or _occupancy(view, [edge_id]) or _is_closed(view, edge_id):
                continue
            name = self._edges[edge_id].name
            by_road.setdefault(name, []).append(edge_id)
            first.setdefault(name, when)
        events = []
        for name in sorted(by_road, key=lambda n: (first[n], n))[:FIRE_CLOSURE_MAX_ROADS_PER_CHECK]:
            self._closed.update(by_road[name])
            self._n += 1
            lead = round((first[name] - at).total_seconds() / 60)
            events.append(_event(self.name, self._n, at, "road_closed",
                                 f"Fire closure ahead of the front on {name} (modelled fire in {lead} min)",
                                 edge_ids=sorted(by_road[name]),
                                 # Stops traffic heading in; people already beyond it may still drive out.
                                 closure_drains=True))
        return events

    def describe(self) -> dict:
        return {
            "agent": "FireRoadClosure",
            "role": "Road closures ahead of the modelled fire front",
            "rules": [
                f"Every {FIRE_CLOSURE_CHECK_EVERY_S // 60} min, close {', '.join(FIRE_CLOSURE_HIGHWAYS)} edges whose "
                f"modelled fire arrival (at the edge midpoint) is within {FIRE_CLOSURE_LEAD_S // 60} min, up to "
                f"{FIRE_CLOSURE_MAX_ROADS_PER_CHECK} named roads per check, earliest arrival first.",
                "Edges with vehicles on them are skipped until empty; closing an edge rebuilds routes (rerouting).",
            ],
            "parameters": {
                "lead_s": FIRE_CLOSURE_LEAD_S, "check_every_s": FIRE_CLOSURE_CHECK_EVERY_S,
                "max_roads_per_check": FIRE_CLOSURE_MAX_ROADS_PER_CHECK, "highways": list(FIRE_CLOSURE_HIGHWAYS),
            },
        }


class EvacuationOfficer:
    """Escalates zones to evacuation orders when modelled fire arrival is within ORDER_LEAD_S."""

    name = "evac-officer"

    def __init__(self, network: RoadNetwork, zones: Sequence[DemandZone], fire_lookup: FireLookup, *,
                 active_from: datetime | None = None):
        self.active_from = active_from
        self._arrival: list[tuple[datetime, str]] = []
        self._zone_names = {z.id: z.name for z in zones}
        for z in zones:
            times = [fire_lookup(*network.nodes[n]) for n in z.origin_nodes]
            times = [t for t in times if t is not None]
            if times:
                self._arrival.append((min(times), z.id))
        self._arrival.sort()
        self._ordered: set[str] = set()
        self._next_dispatch: datetime | None = None
        self._n = 0

    def __call__(self, at: datetime, view) -> list[TrafficEvent]:
        if self.active_from is not None and at < self.active_from:
            return []
        if self._next_dispatch is not None and at < self._next_dispatch:
            return []
        for when, zone_id in self._arrival:
            if when - at > timedelta(seconds=ORDER_LEAD_S):
                break
            if zone_id in self._ordered or _ordered(view, zone_id):
                continue
            self._ordered.add(zone_id)
            self._next_dispatch = at + timedelta(seconds=ORDER_DISPATCH_INTERVAL_S)
            self._n += 1
            lead = round((when - at).total_seconds() / 60)
            return [_event(self.name, self._n, at, "evacuation_order",
                           f"Officer escalates {self._zone_names[zone_id]} to an evacuation order "
                           f"(modelled fire in {lead} min)", zone_ids=[zone_id])]
        return []

    def describe(self) -> dict:
        return {
            "agent": "EvacuationOfficer",
            "role": "Escalates warnings to evacuation orders",
            "rules": [
                f"Order a zone not yet ordered when modelled fire reaches any of its origin nodes within "
                f"{ORDER_LEAD_S // 60} min, earliest arrival first, at most one zone per "
                f"{ORDER_DISPATCH_INTERVAL_S // 60} min.",
            ],
            "parameters": {"lead_s": ORDER_LEAD_S, "dispatch_interval_s": ORDER_DISPATCH_INTERVAL_S},
        }


# --- TrafficView access (sim.traffic.TrafficView)


def _occupancy(view: TrafficView, edge_ids) -> int:
    return sum(view.edge_veh.get(x, 0) for x in edge_ids)


def _is_closed(view: TrafficView, edge_id: str) -> bool:
    return edge_id in view.closed_edge_ids


def _corridor_load(view: TrafficView, edge_ids) -> tuple[int, float]:
    """(vehicles on the edges, vehicle-weighted mean speed / free-flow; 1.0 when empty)."""
    veh = weighted = 0
    for x in edge_ids:
        n = view.edge_veh.get(x, 0)
        if n:
            veh += n
            weighted += n * view.edge_speed_ratio.get(x, 1.0)
    return veh, (weighted / veh if veh else 1.0)


def _ordered(view: TrafficView, zone_id: str) -> bool:
    zone = view.zones.get(zone_id)
    return zone is not None and zone.ordered_at is not None


def default_responders(network: RoadNetwork, zones: Sequence[DemandZone], exits: Sequence[Destination],
                       fire_lookup: FireLookup, *, evacuation_officer: bool = True) -> list:
    """CHP traffic control, fire road closure and (optionally) the evacuation officer.

    Pass the result as `simulate_traffic(..., controllers=...)`; each has `describe()`.
    """
    # Agents act only once the modelled fire exists (its earliest arrival anywhere on the network);
    # before that their lead-time rules would act on a fire nobody could have reported.
    arrivals = [t for t in (fire_lookup(*p) for _, p in sorted(network.nodes.items())) if t is not None]
    active_from = min(arrivals) if arrivals else None
    agents = [ChpTrafficControl(network, exits, fire_lookup, active_from=active_from),
              FireRoadClosure(network, fire_lookup, active_from=active_from)]
    if evacuation_officer:
        agents.append(EvacuationOfficer(network, zones, fire_lookup, active_from=active_from))
    return agents


# --- comparison with history

ACTION_KINDS = {
    "contraflow_started": "contraflow", "contraflow_reported": "contraflow", "contraflow_observed": "contraflow",
    "road_closed": "closure", "road_blocked": "closure", "road_access_restricted": "closure",
    "capacity_changed": "closure",  # soft closures from sim.events
    "evacuation_order": "evacuation_order",
}
_AGENCY = re.compile(r"\b(CHP|Chico PD|BCSO|Cal ?Fire|Paradise PD|PPD|Chico)\b")
_TABLE = re.compile(r"Table [A-Z]-\d+")


def _get(ev, key: str):
    if isinstance(ev, TrafficEvent):
        return {"edge_ids": ev.edge_ids, "zone_ids": ev.zone_ids, "source_id": ev.source_id,
                "source_locator": ev.source_locator, "at": ev.at}.get(key, getattr(ev, key, None))
    if key in ("edge_ids", "zone_ids"):
        return tuple((ev.get("target") or {}).get(key) or ())
    if key in ("source_id", "source_locator"):
        return (ev.get("source") or {}).get(key.split("_", 1)[1])
    if key == "at":
        return datetime.fromisoformat(ev["at"].replace("Z", "+00:00"))
    return ev.get(key)


def _local(at: datetime) -> str:
    return at.astimezone(LOCAL_TZ).strftime("%H:%M")


def compare_with_history(sim_events: Sequence, historical_events: Sequence, *, network: RoadNetwork) -> dict:
    """Match responder actions to the nearest historical action of the same kind on the same road.

    Events may be `TrafficEvent`s or bundle event dicts. Only responder events (source
    RESPONDER_SOURCE_ID) and non-simulated historical events of a known kind take part.
    Roads are compared by canonical name of the event's edges (`network` supplies names).
    """
    edges = {e.id: e for e in network.edges}

    def roads(ev) -> dict[str, str]:
        names = Counter(edges[x].name for x in _get(ev, "edge_ids") if x in edges)
        out: dict[str, str] = {}
        for name, _ in names.most_common():
            out.setdefault(canonical_road_name(name), name)
        return out

    def item(ev, kind: str, road_key: str | None, road_name: str | None) -> dict:
        at = _get(ev, "at")
        return {"event_id": _get(ev, "id"), "kind": kind, "road": road_name, "road_key": road_key,
                "at": format_utc(at), "local_time": _local(at), "label": _get(ev, "label")}

    sims, hist = [], []
    for ev in sim_events:
        kind = ACTION_KINDS.get(_get(ev, "type"))
        # Engine-derived events (e.g. contraflow inbound closures) keep the source id but are `derived`.
        if kind and _get(ev, "source_id") == RESPONDER_SOURCE_ID and _get(ev, "evidence_class") == "simulated":
            sims.append((ev, kind))
    for ev in historical_events:
        kind = ACTION_KINDS.get(_get(ev, "type"))
        if kind and _get(ev, "evidence_class") not in ("simulated", "derived", "fixture") \
                and _get(ev, "source_id") != RESPONDER_SOURCE_ID:
            hist.append((ev, kind))

    hist_by_road: dict[tuple[str, str], list] = {}
    for ev, kind in hist:
        for key, name in roads(ev).items():
            hist_by_road.setdefault((kind, key), []).append((ev, name))

    # A responder acts on a road repeatedly (a fire closure per check as the front advances); the
    # first action per (kind, road) is compared, and later ones are counted as follow-ups.
    first_sim: dict[tuple[str, str], list] = {}
    orders = []
    for ev, kind in sorted(sims, key=lambda p: (_get(p[0], "at"), _get(p[0], "id"))):
        if kind == "evacuation_order":
            orders.append(ev)
            continue
        for key, name in roads(ev).items():
            entry = first_sim.setdefault((kind, key), [ev, name, 0])
            entry[2] += entry[0] is not ev

    matches, unmatched_sim, matched_hist = [], [], set()
    if orders:
        unmatched_sim.append({**item(orders[0], "evacuation_order", None, None), "actions": len(orders),
                              "reason": "historical orders target named places and zones that the fixture zone "
                                        "grid does not model"})
    for (kind, key), (ev, name, follow_ups) in sorted(first_sim.items(), key=lambda kv: (_get(kv[1][0], "at"), kv[0])):
        at = _get(ev, "at")
        cands = hist_by_road.get((kind, key), [])
        if not cands:
            unmatched_sim.append({**item(ev, kind, key, name), "follow_up_actions": follow_ups,
                                  "reason": f"no historical {kind} on {name}"})
            continue
        h, h_name = min(cands, key=lambda c: (abs((_get(c[0], "at") - at).total_seconds()), _get(c[0], "id")))
        h_at = _get(h, "at")
        matched_hist.add((_get(h, "id"), key))
        delta_min = round((at - h_at).total_seconds() / 60)
        locator = _get(h, "source_locator") or ""
        agency = _AGENCY.search(_get(h, "label") or "")
        table = _TABLE.search(locator)
        source = "NIST" if (_get(h, "source_id") or "").startswith("nist") else _get(h, "source_id")
        cite = ", ".join(x for x in (agency.group(1) if agency else None,
                                     f"{source} {table.group(0)}" if table else source) if x)
        matches.append({
            "simulated": {**item(ev, kind, key, name), "follow_up_actions": follow_ups},
            "historical": {**item(h, kind, key, h_name), "evidence_class": _get(h, "evidence_class"),
                           "time_precision": _get(h, "time_precision"),
                           "source": {"id": _get(h, "source_id"), "locator": locator or None}},
            "delta_min": delta_min,
            "text": f"simulated {kind.replace('_', ' ')} on {name} at {_local(at)} vs historical "
                    f"{_local(h_at)} ({cite}): "
                    + ("same time" if delta_min == 0 else
                       f"{abs(delta_min)} min {'earlier' if delta_min < 0 else 'later'}"),
        })

    sim_roads = set(first_sim)
    unmatched_hist = []
    for ev, kind in sorted(hist, key=lambda p: (_get(p[0], "at"), _get(p[0], "id"))):
        rs = roads(ev)
        if not rs:
            unmatched_hist.append({**item(ev, kind, None, None), "reason": "historical event not located on a road"})
        for key, name in rs.items():
            if (_get(ev, "id"), key) in matched_hist:
                continue
            reason = (f"a simulated {kind} on {name} matched a nearer historical action" if (kind, key) in sim_roads
                      else f"no simulated {kind} on {name}")
            unmatched_hist.append({**item(ev, kind, key, name), "reason": reason})
    return {
        "evidence_class": "simulated",
        "rule": "The first responder action of each kind (contraflow, closure) on each road is matched to the "
                "nearest-in-time historical action of the same kind on a road with the same canonical name; "
                "times are local (PST). Location along the road is not compared.",
        "matches": matches,
        "simulated_without_counterpart": unmatched_sim,
        "historical_without_counterpart": unmatched_hist,
    }
