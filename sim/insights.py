"""Planning insights for responders and evacuees, derived only from simulation output."""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sim.geo import Grid, rasterize
from sim.history import format_utc, parse_utc

DISCLAIMER = "Planning insight from a simulation; not operational instructions."
MAX_BOTTLENECKS = 8

# Risk tiers from modelled lead time (fire arrival minus order) and share of a zone's
# vehicles that reached a destination before modelled fire arrival.
CRITICAL_LEAD_S = 0
HIGH_LEAD_S = 60 * 60
ELEVATED_LEAD_S = 120 * 60
CRITICAL_CLEARED_SHARE = 0.5
HIGH_CLEARED_SHARE = 0.8
RISK_RULE = (
    "critical: fire before order or <50% of vehicles out before fire; "
    "high: lead <60 min or <80% out; elevated: lead <120 min; low otherwise (all modelled)"
)


def _risk(lead_s: float | None, cleared_share: float | None) -> str:
    if lead_s is None:
        return "low" if cleared_share is None or cleared_share >= HIGH_CLEARED_SHARE else "elevated"
    if lead_s < CRITICAL_LEAD_S or (cleared_share is not None and cleared_share < CRITICAL_CLEARED_SHARE):
        return "critical"
    if lead_s < HIGH_LEAD_S or (cleared_share is not None and cleared_share < HIGH_CLEARED_SHARE):
        return "high"
    if lead_s < ELEVATED_LEAD_S:
        return "elevated"
    return "low"


def _count_before(series: list, when: datetime | None) -> int | None:
    if when is None:
        return None
    return sum(count for at, count in series if parse_utc(at) <= when)


def build_insights(scenario: dict, traffic: dict, events: list[dict], *, start: datetime,
                   fire_model: tuple[Grid, list[float], datetime] | None) -> dict:
    """Zone lead times, roads' modelled fire arrival, bottlenecks, destination load, headline stats."""
    diagnostics = traffic.get("diagnostics", {})
    zone_stats = diagnostics.get("zone_stats", {})
    edge_stats = diagnostics.get("edge_stats", [])
    destination_stats = diagnostics.get("destination_stats", {})
    edges_by_id = {e.id: e for e in scenario["network"].edges}

    def fire_arrival_in(geometry: dict) -> datetime | None:
        if not fire_model:
            return None
        grid, arrival, t0 = fire_model
        mask = rasterize(grid, geometry)
        times = [a for a, inside in zip(arrival, mask) if inside and math.isfinite(a)]
        return t0 + timedelta(seconds=min(times)) if times else None

    def fire_arrival_at_point(lon: float, lat: float) -> datetime | None:
        if not fire_model:
            return None
        grid, arrival, t0 = fire_model
        cell = grid.cell_of(lon, lat)
        if cell is None or not math.isfinite(arrival[cell]):
            return None
        return t0 + timedelta(seconds=arrival[cell])

    orders: dict[str, datetime] = {}
    for ev in events:
        if ev["type"] == "evacuation_order":
            for zone_id in ev["target"]["zone_ids"]:
                orders.setdefault(zone_id, parse_utc(ev["at"]))

    zones = []
    for zone in scenario["zones"]:
        stats = zone_stats.get(zone.id, {})
        order_at = orders.get(zone.id)
        fire_at = fire_arrival_in(zone.geometry)
        lead_s = (fire_at - order_at).total_seconds() if fire_at and order_at else None
        arrived_by_fire = _count_before(stats.get("arrivals", []), fire_at)
        cleared_share = arrived_by_fire / zone.vehicles if arrived_by_fire is not None and zone.vehicles else None
        arrivals = stats.get("arrivals", [])
        zones.append({
            "zone_id": zone.id,
            "order_at": format_utc(order_at) if order_at else None,
            "fire_arrival_at": format_utc(fire_at) if fire_at else None,
            "lead_time_s": lead_s,
            "vehicles": zone.vehicles,
            "departed_by_fire_veh": _count_before(stats.get("departures", []), fire_at),
            "arrived_by_fire_veh": arrived_by_fire,
            "last_arrival_at": arrivals[-1][0] if arrivals and sum(c for _, c in arrivals) == zone.vehicles else None,
            "risk_level": _risk(lead_s, cleared_share),
            "risk_rule": RISK_RULE,
        })

    edge_fire_arrival_s = []
    for edge_id in traffic["edge_ids"]:
        coords = edges_by_id[edge_id].coords
        lon, lat = coords[len(coords) // 2]
        fire_at = fire_arrival_at_point(lon, lat)
        edge_fire_arrival_s.append(round((fire_at - start).total_seconds()) if fire_at else None)

    ranked = sorted(
        (s for s in edge_stats if s and s.get("peak_veh")),
        key=lambda s: (s.get("minutes_congested", 0), s["peak_veh"]),
        reverse=True,
    )[:MAX_BOTTLENECKS]
    bottlenecks = []
    for s in ranked:
        edge = edges_by_id[traffic["edge_ids"][s["edge_index"]]]
        bottlenecks.append({"edge_id": edge.id, "name": edge.name, "peak_veh": s["peak_veh"], "peak_at": s["peak_at"],
                            "min_speed_kph": s["min_speed_kph"], "minutes_congested": s["minutes_congested"]})

    destinations = [
        {"destination_id": d.id, "arrived_veh": destination_stats.get(d.id, {}).get("arrived_veh", 0),
         "capacity_veh": d.capacity_veh, "full_at": destination_stats.get(d.id, {}).get("full_at")}
        for d in scenario["destinations"]
    ]

    metrics = traffic.get("metrics", [])
    headline = [{"label": "Vehicles modelled", "value": traffic["summary"].get("total_veh"), "unit": "veh", "at": None}]
    for key, label in (("exposed_veh", "Peak vehicles exposed to fire"), ("blocked_veh", "Peak vehicles blocked"),
                       ("en_route_veh", "Peak vehicles on the road")):
        if metrics:
            peak = max(metrics, key=lambda m: m[key])
            headline.append({"label": label, "value": peak[key], "unit": "veh", "at": peak["at"]})
    clearance = traffic["summary"].get("clearance_time_s")
    headline.append({"label": "Clearance time", "value": round(clearance / 60) if clearance is not None else None,
                     "unit": "min", "at": None})
    headline.append({"label": "Zones where modelled fire precedes order",
                     "value": sum(1 for z in zones if z["lead_time_s"] is not None and z["lead_time_s"] < 0),
                     "unit": "zones", "at": None})

    return {
        "evidence_class": "simulated",
        "disclaimer": DISCLAIMER,
        "zones": zones,
        "edge_fire_arrival_s": edge_fire_arrival_s,
        "bottlenecks": bottlenecks,
        "destinations": destinations,
        "headline": headline,
    }
