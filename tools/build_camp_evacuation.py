"""Build an immutable, bounded Camp Fire evacuation data package.

The first acquisition layer is a pre-fire OpenStreetMap road snapshot. Other
layers remain explicitly missing until their source evidence is normalized.
Only the Python standard library and curl are needed.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


INCIDENT_ID = "camp-2018-evacuation"
SNAPSHOT_AT = "2018-11-08T00:00:00Z"
BBOX = (-121.90, 39.55, -121.40, 39.95)  # west, south, east, north
OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
ROAD_CLASSES = (
    "motorway", "motorway_link", "trunk", "trunk_link", "primary",
    "primary_link", "secondary", "secondary_link", "tertiary",
    "tertiary_link", "unclassified", "residential", "living_street",
)
QUERY = (
    '[out:json][timeout:150][date:"2018-11-08T00:00:00Z"];'
    'way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|'
    'primary_link|secondary|secondary_link|tertiary|tertiary_link|'
    'unclassified|residential|living_street|service)$"]'
    '(39.55,-121.90,39.95,-121.40);(._;>;);out body;'
)
NORMALIZER_VERSION = "1"
LAYER_NAMES = (
    "roads", "events", "evacuation_zones", "population_units", "traffic_observations",
    "calibration_targets", "shelters", "fire_progression_reconstructed",
    "displacement",
)


class SourceError(ValueError):
    """Source data cannot be safely normalized."""


def encoded_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download_osm() -> bytes:
    result = subprocess.run(
        ["curl", "--http1.1", "--fail", "--silent", "--show-error", "--location",
         "--retry", "2", "--retry-all-errors", "--retry-delay", "2",
         "--max-time", "180", "--data-urlencode", f"data={QUERY}", OVERPASS_URL],
        capture_output=True,
        check=False,
        timeout=560,
    )
    if result.returncode:
        raise SourceError(
            f"OSM download failed ({result.returncode}): "
            f"{result.stderr.decode(errors='replace').strip()}"
        )
    return result.stdout


def decode_osm(raw: bytes) -> tuple[dict[int, tuple[float, float]], list[dict], dict]:
    try:
        source = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"OSM response is not JSON: {exc}") from exc
    if not isinstance(source, dict) or not isinstance(source.get("elements"), list):
        raise SourceError("OSM response has no elements array")
    if source.get("remark"):
        raise SourceError(f"OSM response contains a failure remark: {source['remark']}")
    nodes: dict[int, tuple[float, float]] = {}
    ways: list[dict] = []
    for element in source["elements"]:
        if not isinstance(element, dict) or type(element.get("id")) is not int:
            raise SourceError("OSM element lacks an integer ID")
        if element.get("type") == "node":
            lon, lat = element.get("lon"), element.get("lat")
            if not all(type(n) in (int, float) and math.isfinite(n) for n in (lon, lat)):
                raise SourceError(f"OSM node {element['id']} has invalid coordinates")
            if element["id"] in nodes:
                raise SourceError(f"duplicate OSM node {element['id']}")
            nodes[element["id"]] = (lon, lat)
        elif element.get("type") == "way":
            if not isinstance(element.get("nodes"), list) or len(element["nodes"]) < 2:
                raise SourceError(f"OSM way {element['id']} has no usable nodes")
            if not isinstance(element.get("tags"), dict):
                raise SourceError(f"OSM way {element['id']} has no tags")
            ways.append(element)
    if not nodes or not ways:
        raise SourceError("OSM extract is empty")
    if any(node_id not in nodes for way in ways for node_id in way["nodes"]):
        raise SourceError("OSM extract is incomplete: a way references an absent node")
    return nodes, ways, source.get("osm3s", {})


def permitted(tags: dict) -> bool:
    if tags.get("highway") not in ROAD_CLASSES:
        return False
    for key in ("access", "vehicle", "motor_vehicle", "motorcar"):
        if tags.get(key) in ("no", "private", "delivery", "agricultural", "forestry"):
            return False
    return True


def direction(tags: dict) -> str:
    oneway = tags.get("oneway")
    if oneway in ("yes", "true", "1"):
        return "forward"
    if oneway == "-1":
        return "reverse"
    if oneway in ("no", "false", "0"):
        return "both"
    if oneway == "reversible":
        return "unknown"
    if tags.get("junction") == "roundabout" or tags.get("highway") in ("motorway", "motorway_link"):
        return "forward"
    return "both"


def tagged_lanes(tags: dict, travel: str, oneway: bool) -> tuple[int | None, str]:
    value = tags.get(f"lanes:{travel}")
    if value is None and oneway:
        value = tags.get("lanes")
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]?", value):
        return int(value), "tagged"
    return None, "unknown"


def tagged_speed(tags: dict) -> tuple[float | None, str]:
    value = tags.get("maxspeed")
    if not isinstance(value, str):
        return None, "unknown"
    match = re.fullmatch(r"([1-9][0-9]?|1[0-9][0-9])(?: (mph|km/h))?", value)
    if not match:
        return None, "unknown"
    speed = float(match.group(1))
    if match.group(2) == "mph":
        speed *= 1.609344
    return round(speed, 6), "tagged"


def segment_length_m(coords: list[tuple[float, float]]) -> float:
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi, dlambda = phi2 - phi1, math.radians(lon2 - lon1)
        a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        total += 6371008.8 * 2 * math.asin(min(1.0, math.sqrt(a)))
    return round(total, 3)


def feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def normalize_roads(raw: bytes) -> tuple[dict, dict, dict, dict]:
    nodes, ways, metadata = decode_osm(raw)
    selected = [way for way in ways if permitted(way["tags"]) and direction(way["tags"]) != "unknown"]
    if not selected:
        raise SourceError("no permitted drivable roads in extract")
    membership: collections.Counter[int] = collections.Counter()
    for way in selected:
        membership.update(set(way["nodes"]))
    used_nodes: set[int] = set()
    edges: list[dict] = []
    exits: dict[int, dict] = {}
    west, south, east, north = BBOX

    def inside(coord: tuple[float, float]) -> bool:
        return west <= coord[0] <= east and south <= coord[1] <= north

    for way in sorted(selected, key=lambda item: item["id"]):
        node_ids = way["nodes"]
        tags = way["tags"]
        cuts = {0, len(node_ids) - 1}
        cuts.update(i for i, node_id in enumerate(node_ids) if membership[node_id] > 1)
        cut_indices = sorted(cuts)
        road_direction = direction(tags)
        directions = ("forward", "reverse") if road_direction == "both" else (road_direction,)
        maxspeed_kph, maxspeed_status = tagged_speed(tags)
        for segment_index, (a, b) in enumerate(zip(cut_indices, cut_indices[1:])):
            segment_ids = node_ids[a:b + 1]
            if len(segment_ids) < 2:
                continue
            segment_coords = [nodes[node_id] for node_id in segment_ids]
            length_m = segment_length_m(segment_coords)
            if length_m <= 0:
                continue
            used_nodes.update((segment_ids[0], segment_ids[-1]))
            for travel in directions:
                ordered_ids = segment_ids if travel == "forward" else list(reversed(segment_ids))
                ordered_coords = segment_coords if travel == "forward" else list(reversed(segment_coords))
                lanes, lanes_status = tagged_lanes(tags, travel, road_direction != "both")
                edge_id = f"osm-way:{way['id']}:{segment_index}:{'f' if travel == 'forward' else 'r'}"
                edges.append({
                    "type": "Feature", "id": edge_id,
                    "geometry": {"type": "LineString", "coordinates": ordered_coords},
                    "properties": {
                        "edge_id": edge_id,
                        "from_node": f"osm-node:{ordered_ids[0]}",
                        "to_node": f"osm-node:{ordered_ids[-1]}",
                        "osm_way_id": way["id"], "name": tags.get("name"), "ref": tags.get("ref"),
                        "highway": tags["highway"], "oneway": road_direction != "both",
                        "lanes": lanes, "lanes_status": lanes_status,
                        "maxspeed_kph": maxspeed_kph, "maxspeed_status": maxspeed_status,
                        "length_m": length_m,
                        "bridge": tags.get("bridge") not in (None, "no"),
                        "tunnel": tags.get("tunnel") not in (None, "no"),
                        "source_id": "osm-overpass-2018", "evidence_class": "observed",
                    },
                })
            for node_id in (segment_ids[0], segment_ids[-1]):
                lon, lat = nodes[node_id]
                if inside((lon, lat)):
                    continue
                if not any(inside(coord) for coord in segment_coords):
                    continue
                distances = {"west": abs(lon - west), "east": abs(lon - east),
                             "south": abs(lat - south), "north": abs(lat - north)}
                exits.setdefault(node_id, {
                    "node_id": f"osm-node:{node_id}", "boundary": min(distances, key=distances.get),
                    "road_name": tags.get("name"), "road_ref": tags.get("ref"),
                    "destination_direction": min(distances, key=distances.get),
                    "destination_name": None,
                })
    if not edges:
        raise SourceError("road normalization produced no directed edges")
    node_features = [
        {"type": "Feature", "id": f"osm-node:{node_id}",
         "geometry": {"type": "Point", "coordinates": nodes[node_id]},
         "properties": {"node_id": f"osm-node:{node_id}", "osm_node_id": node_id,
                        "source_id": "osm-overpass-2018", "evidence_class": "observed"}}
        for node_id in sorted(used_nodes)
    ]
    edges.sort(key=lambda feature: feature["id"])
    exit_list = [exits[node_id] for node_id in sorted(exits)]
    components = largest_scc(used_nodes, edges)
    all_coords = [nodes[node_id] for node_id in used_nodes]
    quality = {
        "source_way_count": len(ways), "selected_way_count": len(selected),
        "excluded_service_way_count": sum(w["tags"].get("highway") == "service" for w in ways),
        "node_count": len(node_features), "directed_edge_count": len(edges),
        "largest_strongly_connected_component_nodes": components,
        "exit_node_count": len(exit_list),
        "actual_bbox": [min(x for x, _ in all_coords), min(y for _, y in all_coords),
                        max(x for x, _ in all_coords), max(y for _, y in all_coords)],
        "osm_base_timestamp": metadata.get("timestamp_osm_base"),
        "snapshot_at": SNAPSHOT_AT,
        "limitations": [
            "OSM is community mapped and may omit roads or 2018 access restrictions.",
            "Service roads are excluded until an egress role is verified.",
            "Unknown directional lane counts and speeds remain null.",
            "Exit nodes are geometric boundary crossings; destination names are unknown.",
        ],
    }
    return feature_collection(node_features), feature_collection(edges), {"exits": exit_list}, quality


def largest_scc(node_ids: set[int], edges: list[dict]) -> int:
    forward: dict[int, list[int]] = {node_id: [] for node_id in node_ids}
    reverse: dict[int, list[int]] = {node_id: [] for node_id in node_ids}
    for edge in edges:
        props = edge["properties"]
        a = int(props["from_node"].split(":")[1])
        b = int(props["to_node"].split(":")[1])
        forward[a].append(b)
        reverse[b].append(a)
    seen: set[int] = set()
    order: list[int] = []
    for start in sorted(node_ids):
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, 0)]
        while stack:
            node_id, position = stack[-1]
            if position < len(forward[node_id]):
                neighbor = forward[node_id][position]
                stack[-1] = (node_id, position + 1)
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append((neighbor, 0))
            else:
                order.append(node_id)
                stack.pop()
    seen.clear()
    largest = 0
    for start in reversed(order):
        if start in seen:
            continue
        count = 0
        stack = [start]
        seen.add(start)
        while stack:
            count += 1
            for neighbor in reverse[stack.pop()]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        largest = max(largest, count)
    return largest


def artifact(path: str, data: bytes, count: int | None = None) -> dict:
    item = {"path": path, "bytes": len(data), "sha256": sha256(data)}
    if count is not None:
        item["count"] = count
    return item


def package_files(raw: bytes, acquired_at: str) -> dict[str, bytes]:
    nodes, edges, exits, quality = normalize_roads(raw)
    files = {
        "raw/osm-roads.json": raw,
        "normalized/road_nodes.geojson": encoded_json(nodes),
        "normalized/road_edges.geojson": encoded_json(edges),
        "normalized/exit_nodes.json": encoded_json(exits),
        "quality.json": encoded_json(quality),
    }
    sources = {
        "osm-overpass-2018": {
            "provider": "OpenStreetMap contributors", "retrieval_endpoint": OVERPASS_URL,
            "query": QUERY, "snapshot_at": SNAPSHOT_AT, "acquired_at": acquired_at,
            "license": "ODbL 1.0", "license_url": "https://www.openstreetmap.org/copyright",
            "attribution": "© OpenStreetMap contributors",
            "raw_path": "raw/osm-roads.json",
        }
    }
    files["sources.json"] = encoded_json(sources)
    version = sha256(raw + NORMALIZER_VERSION.encode())[:16]
    layers = {name: {"status": "missing", "reason": "not yet acquired or normalized"} for name in LAYER_NAMES}
    layers["roads"] = {
        "status": "present", "snapshot_at": SNAPSHOT_AT,
        "node_count": len(nodes["features"]), "directed_edge_count": len(edges["features"]),
        "coverage": "bounded pre-fire OSM roads; mapped coverage is not verified complete",
    }
    manifest = {
        "schema_version": "0.1.0", "normalizer_version": NORMALIZER_VERSION,
        "incident_id": INCIDENT_ID, "incident_number": "CABTU 016737",
        "package_version": version, "evidence_class": "observed",
        "requested_bbox": list(BBOX), "coordinate_reference_system": "OGC:CRS84",
        "coordinate_order": "longitude, latitude", "time_zone": "America/Los_Angeles",
        "focus_window_utc": ["2018-11-08T12:00:00Z", "2018-11-10T08:00:00Z"],
        "layers": layers,
        "artifacts": [artifact(path, data, {
            "normalized/road_nodes.geojson": len(nodes["features"]),
            "normalized/road_edges.geojson": len(edges["features"]),
            "normalized/exit_nodes.json": len(exits["exits"]),
        }.get(path)) for path, data in sorted(files.items())],
    }
    files["manifest.json"] = encoded_json(manifest)
    return files


def build(raw: bytes, output_root: Path) -> Path:
    files = package_files(raw, datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    version = json.loads(files["manifest.json"])["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="camp-evac-", dir=output_root) as temp_dir:
        temporary = Path(temp_dir)
        for name, data in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(temporary), str(target))
    return target


def verify(package: Path) -> dict:
    manifest = json.loads((package / "manifest.json").read_bytes())
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("package identity or normalizer version mismatch")
    for item in manifest["artifacts"]:
        path = package / item["path"]
        data = path.read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
    raw = (package / "raw/osm-roads.json").read_bytes()
    rebuilt = package_files(raw, json.loads((package / "sources.json").read_bytes())["osm-overpass-2018"]["acquired_at"])
    if set(rebuilt) != {item["path"] for item in manifest["artifacts"]} | {"manifest.json"}:
        raise SourceError("package artifact list differs from reproducible build")
    for name, data in rebuilt.items():
        if (package / name).read_bytes() != data:
            raise SourceError(f"offline normalization mismatch: {name}")
    if package.name != manifest["package_version"]:
        raise SourceError("package directory and version differ")
    return json.loads((package / "quality.json").read_bytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--osm-response", type=Path, help="previously downloaded fixed-query response")
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
        return
    raw = args.osm_response.read_bytes() if args.osm_response else download_osm()
    target = build(raw, args.output_root)
    print(target)


if __name__ == "__main__":
    main()
