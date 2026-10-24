"""Load a verified road-network package (camp-2018-evacuation) into traffic engine types."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from tools.add_camp_codedred import verify as verify_with_alerts
from tools.add_camp_road_events import verify as verify_with_road_events
from tools.build_camp_evacuation import verify as verify_roads

from sim.history import parse_utc
from sim.traffic import Destination, RoadEdge, RoadNetwork, TrafficEvent, default_edge_attributes


def _segment_id(edge_id: str) -> str:
    """'osm-way:123:0:f' -> 'osm-way:123:0' so both directions share a display segment."""
    head, _, direction = edge_id.rpartition(":")
    return head if direction in ("f", "b", "r") else edge_id


def load_road_network(package: Path) -> tuple[RoadNetwork, tuple[Destination, ...], dict]:
    """Verified roads plus exit destinations; returns (network, exits, provenance).

    Unknown lanes and speeds take `default_edge_attributes` per highway class; the
    returned provenance counts how many edges used each default so the bundle can
    label them as assumptions.
    """
    manifest = json.loads((package / "manifest.json").read_text())
    # Hashes and offline re-normalization; each package extension has its own verifier.
    if "layers_normalizer_version" in manifest:
        from tools.camp_add_layers import verify as verify_with_layers  # only needed for layered packages

        verify_with_layers(package)
    elif "road_event_normalizer_version" in manifest:
        verify_with_road_events(package)
    elif "event_normalizer_version" in manifest:
        verify_with_alerts(package)
    else:
        verify_roads(package)
    quality = json.loads((package / "quality.json").read_text())
    edge_features = json.loads((package / "normalized/road_edges.geojson").read_text())["features"]
    node_features = json.loads((package / "normalized/road_nodes.geojson").read_text())["features"]
    exits = json.loads((package / "normalized/exit_nodes.json").read_text())["exits"]

    nodes = {f["properties"]["node_id"]: tuple(f["geometry"]["coordinates"]) for f in node_features}
    defaults_used: Counter[str] = Counter()
    edges = []
    for feature in edge_features:
        p = feature["properties"]
        default = default_edge_attributes(p["highway"])
        lanes = p["lanes"]
        speed = p["maxspeed_kph"]
        if lanes is None:
            lanes = default["lanes"]
            defaults_used["lanes"] += 1
        if speed is None:
            speed = default["speed_kph"]
            defaults_used["speed_kph"] += 1
        edges.append(RoadEdge(
            id=p["edge_id"],
            segment_id=_segment_id(p["edge_id"]),
            from_node=p["from_node"],
            to_node=p["to_node"],
            length_m=p["length_m"],
            lanes=lanes,
            speed_kph=speed,
            capacity_veh_per_hour=lanes * default["capacity_veh_per_hour_per_lane"],
            name=p["name"] or p["ref"] or f"unnamed {p['highway'].replace('_', ' ')} road",
            highway=p["highway"],
            bridge=p["bridge"],
            coords=tuple(tuple(c) for c in feature["geometry"]["coordinates"]),
        ))

    destinations = tuple(
        Destination(
            id=f"exit:{x['node_id']}",
            name=f"Exit {x['boundary']}" + (f" via {x['road_name']}" if x["road_name"] else ""),
            kind="exit",
            node_id=x["node_id"],
            coord=nodes[x["node_id"]],
            capacity_veh=None,
        )
        for x in exits
        if x["node_id"] in nodes
    )
    provenance = {
        "incident_id": manifest["incident_id"],
        "package_version": manifest["package_version"],
        "snapshot_at": quality["snapshot_at"],
        "largest_scc_nodes": quality["largest_strongly_connected_component_nodes"],
        "edge_count": len(edges),
        "defaults_used": dict(defaults_used),
        "assumptions": [*quality["limitations"],
            f"Road lanes defaulted by highway class on {defaults_used['lanes']} of {len(edges)} edges "
            f"and free-flow speed on {defaults_used['speed_kph']}; capacity always uses per-lane defaults.",
            "Exits are geometric boundary crossings of the road extract, not named destinations.",
        ],
    }
    return RoadNetwork(nodes=nodes, edges=tuple(edges)), destinations, provenance


def load_alert_events(package: Path) -> tuple[TrafficEvent, ...]:
    """Historical alert events (e.g. NIST CodeRED table) for the replay timeline.

    Their targets are place names or zone IDs without polygons in the package, so they
    are shown as evidence but do not release traffic demand; zone links are dropped.
    """
    path = package / "normalized/events.jsonl"
    if not path.exists():
        return ()
    events = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e["type"] != "alert_sent":
            continue  # road events are resolved onto edges by sim.events
        target = e.get("target") or {}
        where = target.get("place_name") or ", ".join(
            z.rsplit("-", 1)[-1] for z in target.get("zone_ids", [])
        )
        if target.get("zone_ids"):
            where = f"zones {where}"
        status = e.get("evacuation_status_in_message") or "alert"
        attempt = f" ({e['alert_attempt']} attempt)" if e.get("alert_attempt") else ""
        events.append(TrafficEvent(
            id=e["event_id"],
            at=parse_utc(e["occurred_at"]),
            type=e["type"],
            label=f"{e.get('alert_system', 'Alert')} {status}{attempt}: {where}",
            evidence_class=e["evidence_class"],
            time_precision=e["time_precision"],
            source_id=e["source_id"],
            source_locator=e.get("source_locator"),
        ))
    return tuple(events)
