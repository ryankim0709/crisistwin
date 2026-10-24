"""Assemble a replay bundle (docs/replay-bundle.md) from a package, a scenario, and traffic results."""

from __future__ import annotations

import math
from bisect import bisect_right
from datetime import datetime
from pathlib import Path

from sim import SIM_VERSION
from sim.fire_obs import OBSERVATIONS_PATH, load_observations, observation_layer
from sim.firefront import (FIREFRONT_ASSUMPTIONS, arrival_lookup, calibrate_from_ignition, ignition_candidates,
                           isochrones, rothermel_fire)
from sim.geo import EARTH_RADIUS_M
from sim.history import IncidentHistory, format_utc
from sim.insights import build_insights
from sim.replay import TIMELINE_ASSUMPTIONS, TIMELINE_LIMITATIONS
from sim.traffic import TrafficParams, simulate_traffic

SCHEMA_VERSION = "1.0.0"
# Per-destination evidence: exits are boundary crossings of the road extract; refuges and
# shelters come from NIST-reconstructed records. A layer may then be "mixed".
DESTINATION_EVIDENCE = {"exit": "derived", "temporary_refuge": "reconstructed", "shelter": "reconstructed"}
INCIDENT_TIMEZONE = "America/Los_Angeles"
INCIDENT_NAMES = {"camp-2018-paradise-slice": "Camp Fire (2018)"}


def _fire_area_lookup(history: IncidentHistory, simulated_at=None):
    """fire_area_at(t): latest observed perimeter at or before t; before the first, the
    simulated front if given, else None."""
    times = [p.snapshot_at for p in history.perimeters]

    def fire_area_at(at: datetime) -> dict | None:
        index = bisect_right(times, at) - 1
        if index >= 0:
            return history.perimeters[index].geometry
        return simulated_at(at) if simulated_at else None

    return fire_area_at


def _layer_evidence(items, default: str) -> str:
    classes = {item.get("evidence_class", default) if isinstance(item, dict) else default for item in items}
    return classes.pop() if len(classes) == 1 else "mixed"


def _closure_intervals(frames: list[dict]) -> list[list]:
    """Replace per-frame closed lists with [edge_index, first_frame, end_frame | None] intervals.

    end_frame is the first frame where the edge is open again; None means closed to the end.
    """
    intervals, open_since = [], {}
    for k, frame in enumerate(frames):
        closed = set(frame.pop("closed", []))
        for edge in closed - open_since.keys():
            open_since[edge] = k
        for edge in [e for e in open_since if e not in closed]:
            intervals.append([edge, open_since.pop(edge), k])
    intervals.extend([edge, start, None] for edge, start in open_since.items())
    return sorted(intervals, key=lambda iv: (iv[1], iv[0]))


# Key on the fire_simulated block that carries the fire_observations layer to build_bundle; never serialized
# inside fire_simulated (build_bundle moves it to the top-level `fire_observations`).
_OBSERVATIONS_KEY = "_fire_observations"


def _simulated_fire(history: IncidentHistory, end: datetime,
                    roads_package: Path | None = None) -> tuple[dict, object]:
    """fire_simulated bundle block and its hazard lookup.

    With a roads package that has NIST fire observations (camp-2018-evacuation layered package), the
    front is rothermel-mtt from the package ignition on terrain, with frozen calibrated params, and the
    block carries the fire_observations layer. Otherwise the elliptical-mtt-ca front from the assumed
    ignition, fitted to the first perimeter.
    """
    if roads_package is not None and (roads_package / OBSERVATIONS_PATH).exists():
        block, model = rothermel_fire(history, roads_package, end)
        block[_OBSERVATIONS_KEY] = observation_layer(load_observations(roads_package), roads_package, until=end)
        return block, model
    params, arrival, grid, record = calibrate_from_ignition(history, ignition_candidates())
    t0 = datetime.fromisoformat(record["ignition"]["at"].replace("Z", "+00:00"))
    until = min(end, history.perimeters[0].snapshot_at)
    m_per_deg_lat = math.radians(1) * EARTH_RADIUS_M
    mid_lat = grid.origin_lat + grid.nrows * grid.cell_m / m_per_deg_lat / 2
    block = {
        "evidence_class": "simulated",
        "model": record["model"],
        "ignition": record["ignition"],
        "calibration": {"target_snapshot_at": record["target_snapshot_at"], "iou": record["metrics"]["iou"],
                        "area_ratio": record["metrics"]["area_ratio"]},
        "fronts": isochrones(grid, arrival, t0, until=until),
        "arrival_grid": {
            "origin_lon": grid.origin_lon, "origin_lat": grid.origin_lat, "cell_m": grid.cell_m,
            "ncols": grid.ncols, "nrows": grid.nrows,
            "m_per_deg_lon": m_per_deg_lat * math.cos(math.radians(mid_lat)), "m_per_deg_lat": m_per_deg_lat,
            "t0": record["ignition"]["at"],
            "minutes": [round(a / 60) if math.isfinite(a) else None for a in arrival],
        },
        "assumptions": FIREFRONT_ASSUMPTIONS,
    }
    return block, (grid, arrival, t0, arrival_lookup(grid, arrival, t0))


def build_bundle(history: IncidentHistory, scenario: dict, params: TrafficParams, *,
                 start: datetime, end: datetime, command: str, simulate_fire: bool = True,
                 fire: tuple[dict, tuple] | None = None, controllers_for=None,
                 mode: str = "retrospective") -> dict:
    """Run traffic for the scenario and merge it with the package's observed layers.

    `scenario` holds `network`, `zones`, `destinations`, `events` (sim.traffic types),
    an `evidence_class` for those layers (`fixture` until real layers are acquired),
    and `notes`.
    """
    if start >= end:
        raise ValueError("bundle start must be before end")
    scenario_class = scenario["evidence_class"]
    roads_class = scenario.get("roads_evidence_class", scenario_class)
    destinations_class = scenario.get("destinations_evidence_class", scenario_class)
    # `fire` lets callers (e.g. sim.variants) reuse one calibrated front across runs;
    # it is the (block, (grid, arrival, t0, lookup)) pair that _simulated_fire returns.
    if fire is not None:
        fire_block, fire_model = fire
    else:
        fire_block, fire_model = _simulated_fire(history, end) if simulate_fire else (None, None)
    traffic = simulate_traffic(
        scenario["network"], scenario["zones"], scenario["destinations"], scenario["events"], params,
        start=start, end=end, fire_area_at=_fire_area_lookup(history, fire_model[3] if fire_model else None),
        # Agent simulation only: controllers_for(fire_model) -> responder controllers. Replay passes None.
        controllers=controllers_for(fire_model) if controllers_for else (),
    )

    perimeters = [
        {
            "snapshot_index": index,
            "at": format_utc(p.snapshot_at),
            "area_km2": p.area_km2,
            "evidence_class": p.feature["properties"]["evidence_class"],
            "time_precision": p.feature["properties"]["time_precision"],
            "geometry": p.geometry,
        }
        for index, p in enumerate(history.perimeters)
        if p.snapshot_at <= end
    ]
    network = scenario["network"]
    roads = [
        {
            "id": e.id, "segment_id": e.segment_id, "from_node": e.from_node, "to_node": e.to_node,
            "name": e.name, "highway": e.highway, "lanes": e.lanes, "speed_kph": e.speed_kph,
            "capacity_veh_per_hour": e.capacity_veh_per_hour, "length_m": e.length_m, "bridge": e.bridge,
            "coords": [[round(lon, 5), round(lat, 5)] for lon, lat in e.coords],
        }
        for e in network.edges
    ]
    zones = [
        {"id": z.id, "name": z.name, "households": z.households, "vehicles": z.vehicles, "geometry": z.geometry}
        for z in scenario["zones"]
    ]
    destinations = [
        {"id": d.id, "name": d.name, "kind": d.kind, "coord": list(d.coord), "capacity_veh": d.capacity_veh,
         "evidence_class": DESTINATION_EVIDENCE.get(d.kind, destinations_class)}
        for d in scenario["destinations"]
    ]
    events = [
        {
            "id": ev.id, "at": format_utc(ev.at), "type": ev.type, "label": ev.label,
            "evidence_class": ev.evidence_class, "time_precision": ev.time_precision,
            "target": {"zone_ids": list(ev.zone_ids), "edge_ids": list(ev.edge_ids),
                       "destination_id": ev.destination_id},
            "source": {"id": ev.source_id, "locator": ev.source_locator},
        }
        for ev in scenario["events"]
        if start <= ev.at <= end
    ]
    events.extend(traffic.pop("generated_events", []))
    traffic["closures"] = _closure_intervals(traffic["frames"])
    events.extend(
        {
            "id": f"perimeter-{p['snapshot_index']}", "at": p["at"], "type": "perimeter_observed",
            "label": f"Satellite perimeter: {p['area_km2']:.0f} km²", "evidence_class": p["evidence_class"],
            "time_precision": p["time_precision"],
            "target": {"zone_ids": [], "edge_ids": [], "destination_id": None},
            "source": {"id": "feds-veda-archive", "locator": None},
        }
        for p in perimeters
        if p["at"] >= format_utc(start)
    )
    events.sort(key=lambda ev: ev["at"])

    def status(present: bool, evidence: str, missing_reason: str) -> dict:
        if not present:
            return {"status": "missing", "evidence_class": None, "reason": missing_reason}
        return {"status": "fixture" if evidence == "fixture" else "present", "evidence_class": evidence, "reason": None}

    damage_features = [p.feature for p in history.damage]
    observations = fire_block.get(_OBSERVATIONS_KEY) if fire_block else None
    traffic_assumptions = traffic.pop("assumptions", [])
    traffic_limitations = traffic.pop("limitations", [])
    insights = build_insights(scenario, traffic, events, start=start,
                              fire_model=fire_model[:3] if fire_model else None)
    bundle = {
        "kind": "crisistwin_replay_bundle",
        "schema_version": SCHEMA_VERSION,
        "generated_by": {"sim_version": SIM_VERSION, "command": command},
        "incident": {
            "id": history.incident_id,
            "name": INCIDENT_NAMES.get(history.incident_id, history.incident_id),
            "package_version": history.package_version,
            "timezone": INCIDENT_TIMEZONE,
        },
        "mode": mode,
        "clock": {"start": format_utc(start), "end": format_utc(end), "step_seconds": params.record_every_s},
        "bbox": scenario["bbox"],
        "layer_status": {
            "fire_perimeters": status(bool(perimeters), "reconstructed", "no perimeter observed before clock end"),
            "roads": status(bool(roads), roads_class, "road network not acquired"),
            "zones": status(bool(zones), scenario_class, "evacuation zones not acquired"),
            "destinations": status(bool(destinations), destinations_class, "destinations not acquired"),
            "events": status(bool(events), _layer_evidence(events, scenario_class), "no events in window"),
            "traffic": status(True, "simulated", ""),
            "fire_simulated": status(fire_block is not None, "simulated", "simulated fire front disabled"),
            "fire_observations": status(observations is not None, "reconstructed",
                                        "NIST fire observations not in the roads package"),
            "damage": status(bool(damage_features), "observed", "damage assessments not acquired"),
        },
        "assumptions": [*TIMELINE_ASSUMPTIONS, *traffic_assumptions, *scenario.get("notes", [])],
        "limitations": [*TIMELINE_LIMITATIONS, *traffic_limitations],
        "fire": {"perimeters": perimeters},
        "roads": {"evidence_class": roads_class, "edges": roads},
        "zones": {"evidence_class": scenario_class, "features": zones},
        "destinations": {"evidence_class": destinations_class, "features": destinations},
        "events": events,
        "traffic": traffic,
        "damage": {"evidence_class": "observed", "temporal_role": "postfire_assessment", "features": damage_features},
        "insights": insights,
    }
    if fire_block:
        bundle["fire_simulated"] = {k: v for k, v in fire_block.items() if k != _OBSERVATIONS_KEY}
    if observations is not None:
        bundle["fire_observations"] = observations
    return bundle
