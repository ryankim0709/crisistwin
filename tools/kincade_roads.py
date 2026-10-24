"""Merge Overpass attic tiles and build the directed Kincade road graph.

The tile responses are fetched by ``tools/kincade_fetch.py`` with the fixed
query in ``overpass_query`` and kept byte-for-byte (gzip container) in the
package. Normalization reuses the Camp tag rules so both incidents agree.
"""

from __future__ import annotations

import collections

from tools.build_camp_evacuation import (
    decode_osm,
    direction,
    largest_scc,
    permitted,
    segment_length_m,
    tagged_lanes,
    tagged_speed,
)
from tools.kincade_common import BBOX, SNAPSHOT_AT, SourceError, bbox_of

OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
SOURCE_ID = "osm-overpass-2019-10-23"
HIGHWAY_REGEX = (
    "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|"
    "secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"
)
# south, west, north, east (Overpass order). Tiles 1-4 cover the initial
# [-123.05, 38.40, -122.55, 38.90] box; 5-9 extend it to BBOX so that every
# ordered zone polygon is covered. Overlaps are deduplicated by OSM ID.
TILES = (
    (38.40, -123.05, 38.65, -122.80),
    (38.40, -122.80, 38.65, -122.55),
    (38.65, -123.05, 38.90, -122.80),
    (38.65, -122.80, 38.90, -122.55),
    (38.25, -123.20, 38.40, -122.80),
    (38.25, -122.80, 38.40, -122.50),
    (38.40, -123.20, 38.92, -123.05),
    (38.40, -122.55, 38.92, -122.50),
    (38.90, -123.05, 38.92, -122.55),
)

# Destination labels for exits are applied only where an exit's OSM ref and
# boundary side identify a single named corridor end (method recorded).
EXIT_DESTINATIONS = {
    ("US 101", "south"): "US 101 south toward Petaluma / Marin",
    ("US 101", "north"): "US 101 north toward Cloverdale / Mendocino County",
    ("CA 128", "east"): "SR 128 east toward Calistoga / Napa Valley",
    ("CA 128", "north"): "SR 128 north toward Boonville / Anderson Valley",
    ("CA 1", "south"): "SR 1 south toward Bodega Bay / Marin coast",
    ("CA 1", "north"): "SR 1 north toward Sea Ranch / Mendocino coast",
    ("CA 12", "east"): "SR 12 east toward Sonoma Valley",
    ("CA 29", "east"): "SR 29 toward Calistoga / Lake County",
    ("CA 29", "north"): "SR 29 north toward Lake County",
    ("CA 116", "south"): "SR 116 south toward Cotati / Petaluma",
    ("US 101;CA 116", "south"): "US 101 south toward Petaluma / Marin",
    ("CA 29;CA 128", "east"): "SR 29 / SR 128 toward Calistoga / Napa Valley",
    ("CA 53", "north"): "SR 53 north toward Clearlake / Lake County",
    ("CA 1", "west"): "SR 1 north along the coast toward Fort Ross / Sea Ranch",
    ("CA 175", "north"): "SR 175 north toward Cobb / Lake County",
}


def overpass_query(tile: tuple[float, float, float, float]) -> str:
    south, west, north, east = tile
    return (
        f'[out:json][timeout:600][date:"{SNAPSHOT_AT}"];'
        f'way["highway"~"{HIGHWAY_REGEX}"]'
        f"({south:.2f},{west:.2f},{north:.2f},{east:.2f});(._;>;);out body;"
    )


def merge_tiles(tile_payloads: list[bytes]) -> tuple[dict, list[dict], list[dict]]:
    """Return nodes, ways and per-tile metadata; reject conflicting duplicates."""
    if len(tile_payloads) != len(TILES):
        raise SourceError(f"expected {len(TILES)} OSM tiles, got {len(tile_payloads)}")
    nodes: dict[int, tuple[float, float]] = {}
    ways: dict[int, dict] = {}
    meta = []
    for index, payload in enumerate(tile_payloads, 1):
        tile_nodes, tile_ways, osm3s = decode_osm(payload)
        for node_id, coord in tile_nodes.items():
            if nodes.setdefault(node_id, coord) != coord:
                raise SourceError(f"tile {index}: node {node_id} differs between tiles")
        for way in tile_ways:
            previous = ways.setdefault(way["id"], way)
            if previous is not way and (previous["nodes"] != way["nodes"] or previous["tags"] != way["tags"]):
                raise SourceError(f"tile {index}: way {way['id']} differs between tiles")
        meta.append({"tile": index, "south_west_north_east": list(TILES[index - 1]),
                     "way_count": len(tile_ways), "node_count": len(tile_nodes),
                     "timestamp_osm_base": osm3s.get("timestamp_osm_base")})
    return nodes, [ways[k] for k in sorted(ways)], meta


def normalize_roads(tile_payloads: list[bytes]) -> tuple[dict, dict, dict, dict]:
    nodes, ways, tile_meta = merge_tiles(tile_payloads)
    selected = [way for way in ways if permitted(way["tags"]) and direction(way["tags"]) != "unknown"]
    if not selected:
        raise SourceError("no permitted drivable roads in extract")
    membership: collections.Counter[int] = collections.Counter()
    for way in selected:
        membership.update(set(way["nodes"]))
    west, south, east, north = BBOX

    def inside(coord: tuple[float, float]) -> bool:
        return west <= coord[0] <= east and south <= coord[1] <= north

    used_nodes: set[int] = set()
    edges: list[dict] = []
    exits: dict[int, dict] = {}
    for way in selected:
        node_ids, tags = way["nodes"], way["tags"]
        cuts = {0, len(node_ids) - 1}
        cuts.update(i for i, node_id in enumerate(node_ids) if membership[node_id] > 1)
        cut_indices = sorted(cuts)
        road_direction = direction(tags)
        directions = ("forward", "reverse") if road_direction == "both" else (road_direction,)
        maxspeed_kph, maxspeed_status = tagged_speed(tags)
        for segment_index, (a, b) in enumerate(zip(cut_indices, cut_indices[1:])):
            segment_ids = node_ids[a:b + 1]
            segment_coords = [nodes[node_id] for node_id in segment_ids]
            length_m = segment_length_m(segment_coords)
            if len(segment_ids) < 2 or length_m <= 0:
                continue
            used_nodes.update((segment_ids[0], segment_ids[-1]))
            for travel in directions:
                forward = travel == "forward"
                ordered_ids = segment_ids if forward else segment_ids[::-1]
                ordered_coords = segment_coords if forward else segment_coords[::-1]
                lanes, lanes_status = tagged_lanes(tags, travel, road_direction != "both")
                edge_id = f"osm-way:{way['id']}:{segment_index}:{'f' if forward else 'r'}"
                edges.append({
                    "type": "Feature", "id": edge_id,
                    "geometry": {"type": "LineString", "coordinates": [list(c) for c in ordered_coords]},
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
                        "source_id": SOURCE_ID, "evidence_class": "observed",
                    },
                })
            for node_id in (segment_ids[0], segment_ids[-1]):
                coord = nodes[node_id]
                if inside(coord) or not any(inside(c) for c in segment_coords):
                    continue
                distances = {"west": abs(coord[0] - west), "east": abs(coord[0] - east),
                             "south": abs(coord[1] - south), "north": abs(coord[1] - north)}
                side = min(distances, key=distances.get)
                label = EXIT_DESTINATIONS.get((tags.get("ref"), side))
                exits.setdefault(node_id, {
                    "node_id": f"osm-node:{node_id}", "boundary": side,
                    "road_name": tags.get("name"), "road_ref": tags.get("ref"),
                    "highway": tags["highway"],
                    "destination_direction": side,
                    "destination_name": label,
                    "destination_name_method": "derived_from_osm_ref_and_boundary_side" if label else None,
                    "destination_name_status": "derived" if label else "unknown",
                })
    if not edges:
        raise SourceError("road normalization produced no directed edges")
    edges.sort(key=lambda feature: feature["id"])
    node_features = [
        {"type": "Feature", "id": f"osm-node:{node_id}",
         "geometry": {"type": "Point", "coordinates": list(nodes[node_id])},
         "properties": {"node_id": f"osm-node:{node_id}", "osm_node_id": node_id,
                        "source_id": SOURCE_ID, "evidence_class": "observed"}}
        for node_id in sorted(used_nodes)
    ]
    exit_list = [exits[node_id] for node_id in sorted(exits)]
    quality = {
        "source_way_count": len(ways), "selected_way_count": len(selected),
        "node_count": len(node_features), "directed_edge_count": len(edges),
        "largest_strongly_connected_component_nodes": largest_scc(used_nodes, edges),
        "exit_node_count": len(exit_list),
        "named_exit_count": sum(1 for e in exit_list if e["destination_name"]),
        "actual_bbox": bbox_of(nodes[n] for n in used_nodes),
        "requested_bbox": list(BBOX), "snapshot_at": SNAPSHOT_AT, "tiles": tile_meta,
        "limitations": [
            "OSM is community mapped and may omit roads or 2019 access restrictions.",
            "Service roads were not requested; private/no-access ways are excluded.",
            "Unknown directional lane counts and speeds remain null.",
            "Exit nodes are geometric boundary crossings; destination names are labelled only for state/US routes.",
            "Overpass attic data reflects the OSM history as served by the mirror, not a verified 2019 ground survey.",
        ],
    }
    return ({"type": "FeatureCollection", "features": node_features},
            {"type": "FeatureCollection", "features": edges},
            {"exits": exit_list}, quality)
