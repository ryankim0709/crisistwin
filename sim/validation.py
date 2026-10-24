"""Model-versus-published comparison for a grounded Camp replay (sim.scenario.camp_grounded_inputs).

Targets come from the package's `normalized/calibration_targets.json` (published numbers only).
Each row gives the published value, the closest model quantity, and a comparability grade:
  - `partial`: same phenomenon, different definition or population (state the caveat);
  - `tuned`: a model parameter was chosen to match this target, so agreement is not validation;
  - `weak`: a loose analogue (e.g. police holding traffic vs modelled closures);
  - `not_computed`: the model cannot produce it yet (the reason is given).
Nothing here tunes the model; it reports.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sim.events import canonical_road_name
from sim.geo import EARTH_RADIUS_M
from sim.history import parse_utc

LOCAL_TZ = ZoneInfo("America/Los_Angeles")
INCIDENT_LOCAL_DATE = "2018-11-08"
DEPARTED_SHARES = (0.5, 0.9, 0.95)  # "most civilians evacuated" is not quantified by NIST
LARGELY_FREE_SHARE = 0.10  # road "largely free of traffic": vehicles on it <= this x its modelled peak
CLEAR_SHARE = 0.02  # road "clear of traffic"
JUNCTION_RADIUS_M = 300.0  # edges counted as "at" a junction


def _local(at: str | None) -> str | None:
    return None if at is None else parse_utc(at).astimezone(LOCAL_TZ).strftime("%m-%d %H:%M")


def _published_utc(hhmm: str) -> datetime:
    return datetime.fromisoformat(f"{INCIDENT_LOCAL_DATE}T{hhmm}").replace(tzinfo=LOCAL_TZ)


def _delta_min(model_at: str | None, published: datetime) -> int | None:
    return None if model_at is None else round((parse_utc(model_at) - published).total_seconds() / 60)


def _share_time(series: list[list], total: int, share: float) -> str | None:
    """First time the cumulative series reaches share x total."""
    acc = 0
    for at, n in series:
        acc += n
        if total and acc >= share * total:
            return at
    return None


def _closed_by_frame(bundle: dict) -> list[set[int]]:
    frames = bundle["traffic"]["frames"]
    closed: list[set[int]] = [set() for _ in frames]
    for edge, first, end in bundle["traffic"]["closures"]:
        for k in range(first, len(frames) if end is None else end):
            closed[k].add(edge)
    return closed


def _road_series(bundle: dict, edge_indexes: set[int], skip: list[set[int]] | None = None) -> list[tuple[str, int, float]]:
    """(frame time, vehicles, mean speed kph) on the given edges per recorded frame; `skip` drops edges
    closed in that frame (vehicles stopped on a closed edge stay there in the model)."""
    out = []
    for k, frame in enumerate(bundle["traffic"]["frames"]):
        n = speed = 0
        for i, veh, kph in frame["edges"]:
            if i in edge_indexes and not (skip and i in skip[k]):
                n += veh
                speed += veh * kph
        out.append((frame["at"], n, speed / n if n else 0.0))
    return out


def _clear_after_peak(series: list[tuple[str, int, float]], share: float) -> dict:
    if not series or max(n for _, n, _ in series) == 0:
        return {"peak_veh": 0, "peak_at": None, "clear_at": None}
    k = max(range(len(series)), key=lambda j: series[j][1])
    peak = series[k][1]
    clear = next((at for at, n, _ in series[k:] if n <= share * peak), None)
    return {"peak_veh": peak, "peak_at": series[k][0], "clear_at": clear}


def _row(target: dict, model: dict, comparability: str, caveat: str) -> dict:
    return {"target_id": target["target_id"], "metric": target["metric"], "location": target["location"],
            "published": target["value"], "unit": target["unit"], "evidence_class": target["evidence_class"],
            "source_locator": target["source_locator"], "model": model, "comparability": comparability,
            "caveat": caveat}


def calibration_report(bundle: dict, scenario: dict, package: Path) -> dict:
    targets = {t["target_id"]: t for t in json.loads((package / "normalized/calibration_targets.json").read_text())["targets"]}
    report = scenario["demand_report"]
    traffic = bundle["traffic"]
    edge_ids = traffic["edge_ids"]
    edges = {e.id: e for e in scenario["network"].edges}
    zone_stats = traffic["diagnostics"]["zone_stats"]
    zones = {z.id: z for z in scenario["zones"]}
    paradise_zone_ids = [s["zone_id"] for s in report["zones"] if s["in_paradise_set"]]
    paradise_nodes = {n for zid in paradise_zone_ids for n in zones[zid].origin_nodes}
    demand_nodes = {n for z in scenario["zones"] for n in z.origin_nodes}
    rows = []

    # Paradise: most civilians evacuated by 13:45.
    t = targets["nist-s7:paradise:most_civilians_evacuated_by"]
    published = _published_utc(t["value"])
    total = sum(zones[z].vehicles for z in paradise_zone_ids)
    departures = sorted((at, n) for z in paradise_zone_ids for at, n in zone_stats[z]["departures"])
    arrivals = sorted((at, n) for z in paradise_zone_ids for at, n in zone_stats[z]["arrivals"])
    model = {"paradise_set_vehicles": total}
    for share in DEPARTED_SHARES:
        for label, series in (("departed", departures), ("arrived", arrivals)):
            at = _share_time(series, total, share)
            model[f"{label}_{round(share * 100)}pct_at_local"] = _local(at)
            model[f"{label}_{round(share * 100)}pct_delta_min"] = _delta_min(at, published)
    rows.append(_row(t, model, "partial",
                     "NIST does not quantify 'most' and observed traffic, not departures; the model counts vehicles of "
                     "the derived Paradise block-group set leaving origins and reaching an exit of the road extract."))

    # Roads emptying out.
    def road_edges(name: str, nodes: set[str]) -> set[int]:
        return {i for i, eid in enumerate(edge_ids)
                if canonical_road_name(edges[eid].name) == name and edges[eid].from_node in nodes}

    closed = _closed_by_frame(bundle)
    for target_id, road, nodes, share, where in (
            ("nist-t13:clark-rd:largely_free_of_traffic", "clark", paradise_nodes, LARGELY_FREE_SHARE,
             "Clark Road edges starting inside the derived Paradise set"),
            ("nist-t13:neal-rd:clear_of_traffic", "neal", demand_nodes, CLEAR_SHARE,
             "Neal Road edges starting inside demand block groups")):
        t = targets[target_id]
        published = _published_utc(t["value"])
        road_ix = road_edges(road, nodes)
        result = _clear_after_peak(_road_series(bundle, road_ix), share)
        moving = _clear_after_peak(_road_series(bundle, road_ix, closed), share)
        model = {"edges": where, "peak_veh": result["peak_veh"], "peak_at_local": _local(result["peak_at"]),
                 "threshold": f"<= {share:.0%} of modelled peak", "clear_at_local": _local(result["clear_at"]),
                 "delta_min": _delta_min(result["clear_at"], published),
                 "clear_excluding_closed_edges_at_local": _local(moving["clear_at"]),
                 "clear_excluding_closed_edges_delta_min": _delta_min(moving["clear_at"], published)}
        rows.append(_row(t, model, "partial",
                         "NIST reports observed road state at reporting times; the model threshold on its own peak "
                         "is an assumption, and Clark Rd reclosed after briefly opening in 2018. Vehicles trapped on "
                         "closed edges never clear, so a second time excludes closed edges."))

    # Skyway at Clark: all traffic held at 10:45.
    t = targets["nist-t13:skyway-clark:traffic_held"]
    published = _published_utc(t["value"])
    skyway = {n for e in edges.values() if canonical_road_name(e.name) == "skyway" for n in (e.from_node, e.to_node)}
    clark = {n for e in edges.values() if canonical_road_name(e.name) == "clark" for n in (e.from_node, e.to_node)}
    junction = sorted(skyway & clark)
    nodes = scenario["network"].nodes
    m_per_deg = math.radians(1) * EARTH_RADIUS_M

    def near(node: str) -> bool:
        lon, lat = nodes[node]
        return any(math.hypot((lon - nodes[j][0]) * math.cos(math.radians(lat)), lat - nodes[j][1]) * m_per_deg
                   <= JUNCTION_RADIUS_M for j in junction)

    at_junction = {i for i, eid in enumerate(edge_ids) if near(edges[eid].from_node) or near(edges[eid].to_node)}
    frames = traffic["frames"]
    closed_first = min((frames[k]["at"] for i, k, _ in traffic["closures"] if i in at_junction), default=None)
    stopped = next((at for at, n, kph in _road_series(bundle, at_junction) if n and kph == 0.0), None)
    rows.append(_row(t, {"junction_nodes": len(junction), "edges_within_m": JUNCTION_RADIUS_M,
                         "first_closure_at_local": _local(closed_first), "first_closure_delta_min": _delta_min(closed_first, published),
                         "first_stopped_at_local": _local(stopped)},
                     "weak", "Police holding traffic is not modelled; the closest analogue is the first modelled closure "
                             "(fire or reported closure) of an edge near the Skyway/Clark Rd junction."))

    # Temporary refuge areas.
    tra_ids = [d.id for d in scenario["destinations"] if d.kind == "temporary_refuge"]
    for target_id in ("nist-s9:tra_count", "nist-s9:max_simultaneous_tras"):
        t = targets[target_id]
        if not tra_ids:
            rows.append(_row(t, {"tras_used": None}, "not_computed",
                             "TRAs are not destinations until the traffic engine can open and close destinations."))
            continue
        used = [d for d in tra_ids if traffic["summary"]["arrived_by_destination_veh"].get(d, 0) > 0]
        max_active = max((m.get("active_refuges", 0) for m in traffic["metrics"]), default=None)
        model = ({"tras_with_arrivals": len(used)} if target_id.endswith("tra_count")
                 else {"tras_with_arrivals": len(used), "max_simultaneous": max_active})
        rows.append(_row(t, model, "partial",
                         "Model TRAs are the NIST TRAs open in their NIST periods and are used only as a fallback when no "
                         "exit is reachable; a TRA counts as active when open and holding modelled arrivals."))

    # Burnovers: modelled fire entrapments (vehicles_trapped events from the traffic engine).
    t = targets["nist-t30:burnover_count"]
    trapped = [ev for ev in bundle["events"] if ev["type"] == "vehicles_trapped"]
    metrics = traffic["metrics"]
    rows.append(_row(t, {"modelled_entrapment_events": len(trapped),
                         "max_trapped_by_fire_veh": traffic["summary"].get("max_trapped_by_fire_veh"),
                         "peak_exposed_veh": max((m["exposed_veh"] for m in metrics), default=0),
                         "peak_exposed_at_origin_veh": max((m["exposed_at_origin_veh"] for m in metrics), default=0),
                         "events": [{"at_local": _local(ev["at"]), "label": ev["label"]} for ev in trapped[:40]]},
                     "tuned", "Not independent validation: the engine's fire-escape limit (TrafficParams."
                              "fire_escape_max_m) was chosen by sweeping it against this count. A modelled entrapment is a "
                              "road where vehicles are first trapped by fire; NIST burnovers also include people on foot, "
                              "in parking lots and at TRAs."))

    # Crosswalk population checks (input, not model): derived sets vs NIST Table 4 community counts.
    checks = []
    by_zone = {s["zone_id"]: s for s in report["zones"]}
    concow = next(m for m in report["crosswalk"] if m["zone_id"] == "camp-2018-zone-concow")
    for community, members in (("paradise", paradise_zone_ids),
                               ("magalia", [s["zone_id"] for s in report["zones"] if s["in_magalia_set"]]),
                               ("concow", [f"bg:{g}" for g in concow["geoids"]])):
        for metric, key in (("population", "population_in_extract"), ("occupied_housing_units", "households_in_extract")):
            t = targets[f"nist-t4:{community}:{metric}"]
            checks.append({"target_id": t["target_id"], "published": t["value"],
                           "derived_block_groups": len(members),
                           "acs_sum": sum(by_zone[z][key] for z in members if z in by_zone),
                           "caveat": "Block groups do not follow community limits; the derived sets overlap "
                                     "(Paradise and Magalia share block groups)."})

    # TRA input check: simultaneous NIST active periods from the shelter layer.
    periods = [(parse_utc(a), parse_utc(b)) for row in scenario["tra_report"] for a, b in row["active_periods_utc"]]
    points = sorted([(a, 1) for a, _ in periods] + [(b, -1) for _, b in periods], key=lambda p: (p[0], p[1]))
    active = peak = 0
    for _, step in points:
        active += step
        peak = max(peak, active)
    checks.append({"target_id": "nist-s9:max_simultaneous_tras", "published": targets["nist-s9:max_simultaneous_tras"]["value"],
                   "from_shelter_layer": peak, "caveat": "Input consistency of the TRA periods, not a model output."})

    return {"evidence_class": "simulated", "rows": rows, "input_checks": checks,
            "grades": {"partial": "same phenomenon, different definition or population",
                       "weak": "loose analogue", "not_computed": "model cannot produce it yet"}}
