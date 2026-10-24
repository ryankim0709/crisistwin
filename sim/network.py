"""Load a verified road-network package (camp-2018-evacuation) into traffic engine types."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from tools.build_camp_evacuation import verify

from sim.traffic import Destination, RoadEdge, RoadNetwork, default_edge_attributes


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
    quality = verify(package)  # hashes and offline re-normalization; returns quality.json
    manifest = json.loads((package / "manifest.json").read_text())
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
            name=p["name"] or p["ref"] or p["highway"].replace("_", " ").title(),
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
