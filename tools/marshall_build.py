"""Build and verify the immutable Marshall Fire (2021) evacuation data package.

Inputs are raw source responses (OSM attic tiles, NASA VEDA FEDS perimeters,
CDOT OTIS hourly counts), deterministic bbox subsets of bulky Census and FIRMS
files (``tools.marshall_extract``), and hand-curated tables transcribed from
official PDFs (``tools/marshall_*_table.json``). Every normalized layer is
rebuilt from those packaged bytes by ``--verify-package`` without network.
Only the Python standard library is used; downloads are done separately with
curl so that raw bytes are retained exactly.
"""

from __future__ import annotations

import argparse
import collections
import copy
import csv
import io
import json
import math
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from tools.build_camp_evacuation import (
    SourceError,
    decode_osm,
    direction,
    encoded_json,
    largest_scc,
    permitted,
    segment_length_m,
    sha256,
    tagged_lanes,
    tagged_speed,
)


INCIDENT_ID = "marshall-2021-evacuation"
NORMALIZER_VERSION = "marshall-1"
SNAPSHOT_AT = "2021-12-30T00:00:00Z"
BBOX = (-105.30, 39.90, -105.05, 40.03)  # west, south, east, north (lon/lat)
LOCAL_ZONE = ZoneInfo("America/Denver")
FOCUS_WINDOW_UTC = ("2021-12-30T16:00:00Z", "2022-01-01T12:00:00Z")
OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
OSM_SOURCE_ID = "osm-overpass-2021-12-30"
TOOLS = Path(__file__).parent
CURATED_TABLES = {
    "curated/marshall_events_table.json": TOOLS / "marshall_events_table.json",
    "curated/marshall_calibration_table.json": TOOLS / "marshall_calibration_table.json",
    "curated/marshall_shelters_table.json": TOOLS / "marshall_shelters_table.json",
    "curated/marshall_sources_table.json": TOOLS / "marshall_sources_table.json",
}
LAYER_NAMES = (
    "roads", "events", "evacuation_zones", "population_units", "zone_population_crosswalk",
    "traffic_observations", "calibration_targets", "shelters", "fire_perimeters",
    "fire_progression_reconstructed", "fire_detections", "displacement", "terrain_grid",
    "buildings", "street_imagery", "media_evidence",
)
BBOX_JUSTIFICATION = (
    "Contains the FEDS F2391 final perimeter extent [-105.2371,39.9306,-105.1464,39.9824] "
    "with 5-10 km margins, the origin area near CO 93/Eldorado Springs Dr, Superior, "
    "Louisville, the US 36 corridor from Boulder to Broomfield (Flatirons Crossing "
    "staging), SH 128, SH 170, McCaslin Blvd, South Boulder Rd and the eastbound "
    "egress roads (South Boulder Rd, Empire Rd, Dillon Rd) named in the AAR."
)


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_dt(text: str) -> datetime:
    value = datetime.fromisoformat(text)
    if value.tzinfo is None or value.utcoffset() != LOCAL_ZONE.utcoffset(value.replace(tzinfo=None)):
        raise SourceError(f"local time {text!r} lacks the America/Denver offset")
    return value


def feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def jsonl(records: list[dict]) -> bytes:
    return b"".join(encoded_json(record) for record in records)


def load_json(data: bytes, label: str) -> object:
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"{label} is not valid JSON: {exc}") from exc


# --------------------------------------------------------------------------- roads

def merge_osm_tiles(tiles: dict[str, bytes]) -> tuple[dict[int, tuple[float, float]], list[dict], dict]:
    nodes: dict[int, tuple[float, float]] = {}
    ways: dict[int, dict] = {}
    metadata: dict = {"tile_osm_base_timestamps": {}}
    for name in sorted(tiles):
        tile_nodes, tile_ways, tile_meta = decode_osm(tiles[name])
        metadata["tile_osm_base_timestamps"][name] = tile_meta.get("timestamp_osm_base")
        for node_id, coord in tile_nodes.items():
            if nodes.setdefault(node_id, coord) != coord:
                raise SourceError(f"OSM node {node_id} differs between tiles")
        for way in tile_ways:
            previous = ways.setdefault(way["id"], way)
            if previous["nodes"] != way["nodes"] or previous["tags"] != way["tags"]:
                raise SourceError(f"OSM way {way['id']} differs between tiles")
    return nodes, [ways[way_id] for way_id in sorted(ways)], metadata


def normalize_roads(tiles: dict[str, bytes]) -> tuple[dict, dict, dict, dict]:
    nodes, ways, metadata = merge_osm_tiles(tiles)
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

    for way in selected:
        node_ids, tags = way["nodes"], way["tags"]
        cut_indices = sorted({0, len(node_ids) - 1} | {i for i, n in enumerate(node_ids) if membership[n] > 1})
        road_direction = direction(tags)
        directions = ("forward", "reverse") if road_direction == "both" else (road_direction,)
        maxspeed_kph, maxspeed_status = tagged_speed(tags)
        for segment_index, (a, b) in enumerate(zip(cut_indices, cut_indices[1:])):
            segment_ids = node_ids[a:b + 1]
            segment_coords = [nodes[n] for n in segment_ids]
            length_m = segment_length_m(segment_coords)
            if len(segment_ids) < 2 or length_m <= 0:
                continue
            used_nodes.update((segment_ids[0], segment_ids[-1]))
            for travel in directions:
                ordered_ids = segment_ids if travel == "forward" else segment_ids[::-1]
                ordered_coords = segment_coords if travel == "forward" else segment_coords[::-1]
                lanes, lanes_status = tagged_lanes(tags, travel, road_direction != "both")
                edge_id = f"osm-way:{way['id']}:{segment_index}:{'f' if travel == 'forward' else 'r'}"
                edges.append({
                    "type": "Feature", "id": edge_id,
                    "geometry": {"type": "LineString", "coordinates": [list(c) for c in ordered_coords]},
                    "properties": {
                        "edge_id": edge_id, "from_node": f"osm-node:{ordered_ids[0]}",
                        "to_node": f"osm-node:{ordered_ids[-1]}", "osm_way_id": way["id"],
                        "name": tags.get("name"), "ref": tags.get("ref"), "highway": tags["highway"],
                        "oneway": road_direction != "both", "lanes": lanes, "lanes_status": lanes_status,
                        "maxspeed_kph": maxspeed_kph, "maxspeed_status": maxspeed_status,
                        "length_m": length_m, "bridge": tags.get("bridge") not in (None, "no"),
                        "tunnel": tags.get("tunnel") not in (None, "no"),
                        "source_id": OSM_SOURCE_ID, "evidence_class": "observed",
                    },
                })
            for node_id in (segment_ids[0], segment_ids[-1]):
                lon, lat = nodes[node_id]
                if inside((lon, lat)) or not any(inside(c) for c in segment_coords):
                    continue
                distances = {"west": abs(lon - west), "east": abs(lon - east),
                             "south": abs(lat - south), "north": abs(lat - north)}
                side = min(distances, key=distances.get)
                exits.setdefault(node_id, {
                    "node_id": f"osm-node:{node_id}", "boundary": side,
                    "road_name": tags.get("name"), "road_ref": tags.get("ref"),
                    "highway": tags["highway"], "destination_direction": side,
                    "destination_name": None, "destination_name_status": "unknown",
                })
    edges.sort(key=lambda feature: feature["id"])
    node_features = [
        {"type": "Feature", "id": f"osm-node:{n}",
         "geometry": {"type": "Point", "coordinates": list(nodes[n])},
         "properties": {"node_id": f"osm-node:{n}", "osm_node_id": n,
                        "source_id": OSM_SOURCE_ID, "evidence_class": "observed"}}
        for n in sorted(used_nodes)
    ]
    coords = [nodes[n] for n in used_nodes]
    exit_list = [exits[n] for n in sorted(exits)]
    quality = {
        "source_tile_count": len(tiles), "source_way_count": len(ways), "selected_way_count": len(selected),
        "excluded_service_way_count": sum(w["tags"].get("highway") == "service" for w in ways),
        "node_count": len(node_features), "directed_edge_count": len(edges),
        "largest_strongly_connected_component_nodes": largest_scc(used_nodes, edges),
        "exit_node_count": len(exit_list),
        "actual_bbox": [min(x for x, _ in coords), min(y for _, y in coords),
                        max(x for x, _ in coords), max(y for _, y in coords)],
        "osm_base_timestamps_by_tile": metadata["tile_osm_base_timestamps"], "snapshot_at": SNAPSHOT_AT,
        "limitations": [
            "OSM is community mapped and may omit roads or 2021 access restrictions.",
            "Service roads and private/no-access ways are excluded.",
            "Unknown directional lane counts and speeds remain null; nothing is inferred.",
            "Exit nodes are geometric bbox crossings; destination names are unknown.",
            "The bbox was queried as four tiles; ways crossing tile edges are merged by OSM ID after an equality check.",
        ],
    }
    return feature_collection(node_features), feature_collection(edges), {"exits": exit_list}, quality


# --------------------------------------------------------------------------- events

def event_record(**fields: object) -> dict:
    record = {
        "event_id": None, "type": None, "occurred_at": None, "occurred_from": None, "occurred_to": None,
        "time_precision": None, "time_role": None, "available_at": None, "available_at_status": "unknown",
        "available_at_reason": "retrospective source does not establish when the public or responders knew",
        "local_time_as_written": None, "target": None, "geometry": None, "geocode_method": "unresolved",
        "description": None, "quote": None, "evidence_class": None, "source_id": None,
        "source_locator": None, "related_event_ids": [],
    }
    record.update(fields)
    return record


def zone_id_for(label: str) -> str:
    match = re.fullmatch(r"Marshall Fire (\d)([ab]?)", label, re.I)
    if not match:
        raise SourceError(f"unexpected Everbridge map label {label!r}")
    return f"boco-everbridge-2021-marshall-{match.group(1)}{match.group(2).lower()}"


def normalize_events(table: dict) -> list[dict]:
    if table.get("time_zone") != "America/Denver":
        raise SourceError("event table must use America/Denver")
    sources = table["sources"]
    everbridge = sources["boco-everbridge-2022-01-06"]
    aar = sources["boco-aar-marshall-2022"]
    events: list[dict] = []
    contacts = 0
    for row in table["everbridge_messages"]:
        number = row["row"]
        sent, issued = local_dt(row["sent_local"]), local_dt(row["issued_local"])
        if not timedelta(0) <= sent - issued <= timedelta(seconds=5):
            raise SourceError(f"Everbridge row {number}: send and issue times disagree")
        if type(row["total_contacts"]) is not int or row["total_contacts"] < 0:
            raise SourceError(f"Everbridge row {number}: invalid contact count")
        contacts += row["total_contacts"]
        kind = {"Evacuation Order": "evacuation_order", "Evacuation Warning": "evacuation_warning"}[row["message_title"]]
        zones = [zone_id_for(label) for label in row["map_labels"]]
        locator = f"{everbridge['retrieval_url']}#page=3; table 'What messages were sent during the Marshall Fire?'; row {number}"
        base = f"boco-everbridge:{number:02d}"
        common = {
            "target": {"zone_ids": zones, "place_name": row["area_as_written"]},
            "evidence_class": "observed", "source_id": "boco-everbridge-2022-01-06",
            "source_locator": locator, "message_title": row["message_title"],
            "destination_as_written": row["destination_as_written"],
        }
        events.append(event_record(
            event_id=f"{base}:issued", type=kind, occurred_at=utc_text(issued), occurred_from=utc_text(issued),
            occurred_to=utc_text(issued + timedelta(seconds=1)), time_precision="second",
            time_role="issue time stated inside the launched message text",
            local_time_as_written=row["issued_local_as_written"],
            description=f"{row['message_title']} issued for {row['area_as_written']} (Everbridge launch areas {', '.join(row['map_labels'])}).",
            quote=row["quote"], related_event_ids=[f"{base}:sent"], **common))
        events.append(event_record(
            event_id=f"{base}:sent", type="alert_sent", occurred_at=utc_text(sent), occurred_from=utc_text(sent),
            occurred_to=utc_text(sent + timedelta(seconds=1)), time_precision="second",
            time_role="Everbridge launch (send) time; not receipt",
            local_time_as_written=f"12/30/2021 {sent.strftime('%H:%M:%S')}",
            description=f"Everbridge {row['message_title'].lower()} launched to {row['total_contacts']} registered contacts.",
            alert_system="Everbridge", alert_channels="registered landline, VoIP, cell voice/text, email, TTY/TDD",
            count_contacts=row["total_contacts"], quote=None, related_event_ids=[f"{base}:issued"], **common))
    for row in table["aar_events"]:
        locator = f"{aar['url']}#page={row['pdf_page']}; printed p. {row['printed_page']}; {row['section']}"
        source_id = "boco-aar-marshall-2022"
        if len(row["quote"].split()) > 25:
            raise SourceError(f"quote too long in {row['id']}")
        extra = {k: row[k] for k in ("supporting_locators",) if k in row}
        if "local_date" in row:
            day = datetime.fromisoformat(row["local_date"]).replace(tzinfo=LOCAL_ZONE)
            start, end = day, day + timedelta(days=1)
            fields = dict(occurred_at=utc_text(start), occurred_from=utc_text(start), occurred_to=utc_text(end),
                          time_precision="day", time_role="untimed narrative statement about this local date",
                          local_time_as_written=None)
        else:
            moment = local_dt(row["local_time"])
            if row.get("time_role") == "latest_bound":
                fields = dict(occurred_at=utc_text(moment), occurred_from=None, occurred_from_status="unknown",
                              occurred_to=utc_text(moment), time_precision="approximate",
                              time_role="latest bound: the fire existed by this dispatch time; ignition instant unpublished",
                              local_time_as_written=moment.strftime("%H%M"))
            else:
                fields = dict(occurred_at=utc_text(moment), occurred_from=utc_text(moment),
                              occurred_to=utc_text(moment + timedelta(minutes=1)), time_precision="minute",
                              time_role="time an action or report was logged in the AAR timeline",
                              local_time_as_written=moment.strftime("%H%M"))
        events.append(event_record(
            event_id=f"boco-aar:{row['id']}", type=row["type"], target=row["target"],
            description=row["description"], quote=row["quote"], evidence_class="reported",
            source_id=source_id, source_locator=locator,
            related_event_ids=row.get("related_event_ids", []), **fields, **extra))
    if contacts != 24289:
        raise SourceError(f"Everbridge contacts sum {contacts} differs from the published 24,289")
    ids = [event["event_id"] for event in events]
    if len(ids) != len(set(ids)):
        raise SourceError("duplicate event IDs")
    events.sort(key=lambda event: (event["occurred_at"], event["event_id"]))
    return events


def normalize_zones(table: dict, digitized: bytes | None = None) -> dict:
    shapes = {}
    georeference = None
    if digitized is not None:
        source = load_json(digitized, "digitized zones")
        shapes = {f["id"]: f for f in source["features"]}
        georeference = source["georeference"]
    labels: dict[str, dict] = {}
    for row in table["everbridge_messages"]:
        for label in row["map_labels"]:
            zone_id = zone_id_for(label)
            shape = shapes.get(zone_id)
            if shape is not None:
                map_type = shape["properties"]["message_title"]
                map_time = datetime.strptime(shape["properties"]["map_time_local"], "%I:%M %p")
                sent = local_dt(row["sent_local"])
                if map_type != row["message_title"] or (map_time.hour, map_time.minute) != (sent.hour, sent.minute):
                    raise SourceError(f"map layer for {zone_id} disagrees with Everbridge row {row['row']}")
            labels[zone_id] = {
                "zone_id": zone_id, "name": re.sub(r"(\d)([ab])$", lambda m: m.group(1) + m.group(2).upper(), label),
                "zone_system": "Boulder County Everbridge launch areas, Marshall Fire",
                "zone_system_version": "2021-12-30 ad hoc (drawn on the fly by dispatchers, per the county release)",
                "message_title": row["message_title"], "first_message_sent_local": row["sent_local"],
                "first_message_sent_utc": utc_text(local_dt(row["sent_local"])), "everbridge_row": row["row"],
                "geometry_status": "derived" if shape else "unknown",
                "geometry_method": ("vector paths of the zone's optional-content layer in the county GeoPDF, "
                                    "georeferenced from its /GPTS + /LPTS measure (tools/marshall_geopdf.py)") if shape else None,
                "geometry_reason": None if shape else "zone polygon not digitized",
                "georeference_max_residual_m": georeference["affine_fit_max_residual_m"] if shape else None,
                "geometry_precision_note": "export resolution about 2 m; source polygon accuracy not assessed" if shape else None,
                "geometry_source_id": "boco-everbridge-map-2022-01-06" if shape else None,
                "source_id": "boco-everbridge-2022-01-06", "evidence_class": "observed",
                "geometry_evidence_class": "derived" if shape else None,
            }
    features = [{"type": "Feature", "id": z, "geometry": shapes[z]["geometry"] if z in shapes else None,
                 "properties": labels[z]} for z in sorted(labels)]
    for number in (1, 2, 3, 4):
        zone_id = f"louisville-zone-{number}"
        features.append({"type": "Feature", "id": zone_id, "geometry": None, "properties": {
            "zone_id": zone_id, "name": f"Louisville Zone {number}", "zone_system": "City of Louisville evacuation zones",
            "zone_system_version": "unknown (in force 2021-12-30)", "geometry_status": "unknown",
            "geometry_reason": "Named in the AAR (15:37 entry); no Louisville zone polygons were acquired.",
            "source_id": "boco-aar-marshall-2022", "evidence_class": "reported"}})
    return feature_collection(features)


CROSSWALK_ROW_M = 5.0
LOCAL_ORIGIN = (-105.175, 39.965)


def to_local_m(coord: list[float]) -> tuple[float, float]:
    """Equirectangular metres about LOCAL_ORIGIN; area ratios over ~20 km are unaffected."""
    lon0, lat0 = LOCAL_ORIGIN
    return ((coord[0] - lon0) * 111320.0 * math.cos(math.radians(lat0)), (coord[1] - lat0) * 110574.0)


def polygon_rings_m(geometry: dict) -> list[list[tuple[float, float]]]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return [[to_local_m(c) for c in ring] for polygon in polygons for ring in polygon]


def rings_area_m2(rings: list[list[tuple[float, float]]]) -> float:
    """Even-odd area: |outer| minus |holes| when rings are given with any orientation."""
    total = 0.0
    for ring in rings:
        total += sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2
    return abs(total)


def row_intervals(rings: list[list[tuple[float, float]]], y: float) -> list[tuple[float, float]]:
    xs = sorted(x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                for ring in rings for (x1, y1), (x2, y2) in zip(ring, ring[1:]) if (y1 > y) != (y2 > y))
    return list(zip(xs[0::2], xs[1::2]))


def overlap_length(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> float:
    total, i, j = 0.0, 0, 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            total += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def normalize_crosswalk(zones: dict, population: dict) -> dict:
    units = []
    for feature in population["features"]:
        rings = polygon_rings_m(feature["geometry"])
        ys = [y for ring in rings for _, y in ring]
        units.append((feature["id"], rings, min(ys), max(ys), rings_area_m2(rings), feature["properties"]))
    records = []
    for zone in zones["features"]:
        if zone["geometry"] is None:
            continue
        zone_rings = polygon_rings_m(zone["geometry"])
        zys = [y for ring in zone_rings for _, y in ring]
        y_min, y_max = min(zys), max(zys)
        overlap: dict[str, float] = collections.defaultdict(float)
        rows = int(math.ceil((y_max - y_min) / CROSSWALK_ROW_M))
        for row in range(rows):
            y = y_min + (row + 0.5) * CROSSWALK_ROW_M  # midpoint rule
            zone_iv = row_intervals(zone_rings, y)
            if not zone_iv:
                continue
            for geoid, rings, low, high, _, _ in units:
                if low <= y <= high:
                    length = overlap_length(zone_iv, row_intervals(rings, y))
                    if length:
                        overlap[geoid] += length * CROSSWALK_ROW_M
        zone_area = rings_area_m2(zone_rings)
        shares = []
        for geoid, rings, _, _, unit_area, props in units:
            if overlap.get(geoid, 0) <= 0:
                continue
            share = min(1.0, overlap[geoid] / unit_area)
            shares.append({"geoid": geoid, "share_of_unit_area": round(share, 6),
                           "share_of_zone_area": round(overlap[geoid] / zone_area, 6),
                           "population_weighted": round(props["population"] * share, 3),
                           "households_weighted": round(props["households"] * share, 3)})
        records.append({"zone_id": zone["id"], "zone_area_m2": round(zone_area, 1),
                        "covered_share_of_zone": round(sum(s["share_of_zone_area"] for s in shares), 6),
                        "units": shares})
    return {
        "method": ("Area-weighted: overlap area of each 2020 block group with each digitized Everbridge launch area, "
                   f"integrated by horizontal scanlines every {CROSSWALK_ROW_M:g} m (midpoint rule) in an "
                   "equirectangular metre plane about lon -105.175, lat 39.965; share = overlap / block-group polygon area "
                   "(land and water). Assumes population is uniform within a block group."),
        "evidence_class": "derived", "acs_vintage": "2016-2020 ACS 5-year",
        "caveat": "Launch areas overlap each other; summing weighted population across zones double-counts.",
        "zones": records,
    }


# --------------------------------------------------------------------------- shelters

def normalize_shelters(table: dict, facilities_raw: bytes | None, events: list[dict]) -> dict:
    facilities: dict[str, dict] = {}
    if facilities_raw is not None:
        for element in load_json(facilities_raw, "OSM facilities")["elements"]:
            facilities[f"{element['type']}/{element['id']}"] = element
    features = []
    for row in table["shelters"]:
        related = [e for e in events if e["target"].get("shelter_id") == row["shelter_id"]]
        opened = [e for e in related if e["type"] == "shelter_opened"]
        geometry, method = None, "unresolved"
        osm_ref = row.get("osm_element")
        if osm_ref:
            element = facilities.get(osm_ref)
            if element is None:
                raise SourceError(f"OSM element {osm_ref} for {row['shelter_id']} is absent from raw/osm-facilities.json")
            point = element.get("center") or {"lat": element.get("lat"), "lon": element.get("lon")}
            if element.get("tags", {}).get("name") != row["osm_name"]:
                raise SourceError(f"OSM name mismatch for {row['shelter_id']}")
            geometry = {"type": "Point", "coordinates": [point["lon"], point["lat"]]}
            method = ("osm_feature_name_match; point is the Overpass 'center' (bounding-box centre) of the way"
                      if "center" in element else "osm_node_name_match")
        features.append({"type": "Feature", "id": row["shelter_id"], "geometry": geometry, "properties": {
            "shelter_id": row["shelter_id"], "name": row["name"], "kind": row["kind"],
            "operator": row.get("operator"), "address_public_facility": row.get("address_public_facility"),
            "opened_at": opened[0]["occurred_at"] if opened else None,
            "opened_at_status": "reported_open_by" if opened else "unknown",
            "first_named_at": min([e["occurred_at"] for e in events
                                   if e["event_id"] in {x["event_id"] for x in related} | set(row.get("related_event_ids", []))],
                                  default=None),
            "capacity_persons": None, "capacity_persons_status": "unknown",
            "capacity_reason": "no published capacity found",
            "occupancy_reports": [], "occupancy_reports_status": "none_published",
            "related_event_ids": [e["event_id"] for e in related] + row.get("related_event_ids", []),
            "osm_element": osm_ref, "geocode_method": method,
            "geocode_source_id": "osm-overpass-facilities-2021-12-30" if osm_ref else None,
            "source_id": row["source_id"], "source_locator": row["source_locator"],
            "evidence_class": row["evidence_class"],
        }})
    return feature_collection(features)


# --------------------------------------------------------------------------- calibration

def normalize_calibration(table: dict) -> dict:
    targets = []
    for row in table["targets"]:
        record = copy.deepcopy(row)
        window = row.get("window_local")
        record["window_utc"] = None if window is None else [
            None if value is None else utc_text(local_dt(value)) for value in window]
        if row.get("unit") == "local_time":
            record["value_utc"] = utc_text(local_dt(row["value"]))
        targets.append(record)
    return {"targets": targets, "interpretation": table["interpretation"]}


# --------------------------------------------------------------------------- fire

def normalize_perimeters(raw: bytes) -> dict:
    source = load_json(raw, "FEDS response")
    features = []
    for feature in sorted(source["features"], key=lambda f: f["properties"]["t"]):
        props = feature["properties"]
        if props.get("fireid") != "F2391":
            raise SourceError("unexpected FEDS fire ID")
        local = datetime.fromisoformat(props["t"]).replace(tzinfo=LOCAL_ZONE)
        features.append({"type": "Feature", "id": f"feds:F2391:{props['t']}", "geometry": feature["geometry"],
                         "properties": {
            "perimeter_id": f"feds:F2391:{props['t']}", "fireid": "F2391", "t_as_written": props["t"],
            "t_utc": utc_text(local), "t_utc_method": "derived: VEDA documents t as local time corrected to noon/midnight; America/Denver applied",
            "time_precision": "half_day", "farea_km2": props["farea"], "fperim_km": props["fperim"],
            "flinelen_km": props["flinelen"], "duration_days": props["duration"], "meanfrp_mw": props["meanfrp"],
            "n_pixels": props["n_pixels"], "n_newpixels": props["n_newpixels"],
            "evidence_class": "observed", "evidence_note": "satellite active-fire derived cumulative perimeter (algorithmic)",
            "source_id": "nasa-veda-feds", "available_at": None, "available_at_status": "unknown"}})
    if len(features) != source.get("numberMatched"):
        raise SourceError("FEDS response is paginated or incomplete")
    return feature_collection(features)


def normalize_detections(subsets: dict[str, bytes]) -> dict:
    features = []
    for name in sorted(subsets):
        reader = csv.DictReader(io.StringIO(subsets[name].decode()))
        product = name.split("firms-subset-")[1].split("_")[0]
        for index, row in enumerate(reader):
            acquired = datetime.strptime(row["acq_date"] + row["acq_time"].zfill(4), "%Y-%m-%d%H%M").replace(tzinfo=timezone.utc)
            lon, lat = float(row["longitude"]), float(row["latitude"])
            is_modis = row["instrument"] == "MODIS"
            features.append({"type": "Feature", "id": f"firms:{product}:{index}",
                             "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {
                "detection_id": f"firms:{product}:{index}", "product": product,
                "satellite": row["satellite"], "instrument": row["instrument"],
                "acquired_at": utc_text(acquired), "time_precision": "minute",
                "acq_date_as_written": row["acq_date"], "acq_time_as_written": row["acq_time"],
                "confidence_as_written": row["confidence"],
                "confidence_scale": "0-100 percent" if is_modis else "l/n/h (low/nominal/high)",
                "brightness_k": float(row["brightness" if is_modis else "bright_ti4"]),
                "brightness_band": "MODIS 21/22" if is_modis else "VIIRS I-4",
                "frp_mw": float(row["frp"]), "scan_km": float(row["scan"]), "track_km": float(row["track"]),
                "daynight": row["daynight"], "firms_type": row["type"], "collection_version": row["version"],
                "geometry_meaning": "pixel centre; footprint is scan x track km",
                "evidence_class": "observed", "source_id": f"nasa-firms-{product}-2021-us",
            }})
    features.sort(key=lambda f: (f["properties"]["acquired_at"], f["id"]))
    return feature_collection(features)


# --------------------------------------------------------------------------- population

def acs_int(value: str) -> int | None:
    return None if value in ("", ".", "-") or not re.fullmatch(r"-?\d+", value) else int(value)


def normalize_population(bg: bytes, acs: bytes) -> dict:
    shapes = load_json(bg, "TIGER subset")["features"]
    data = load_json(acs, "ACS subset")["block_groups"]
    features = []
    for shape in shapes:
        geoid = shape["id"]
        est, moe = data[geoid]["estimates"], data[geoid]["margins_of_error"]
        b01001 = [acs_int(v) for v in est["B01001"]]
        b25044 = [acs_int(v) for v in est["B25044"]]
        population, households = acs_int(est["B01003"][0]), acs_int(est["B11001"][0])
        if population is None or households is None or b01001[0] != population or b25044[0] != households:
            raise SourceError(f"ACS internal totals disagree for {geoid}")
        by_vehicles = {f"households_{label}": b25044[1 + i] + b25044[8 + i]
                       for i, label in enumerate(("0_vehicles", "1_vehicle", "2_vehicles", "3_vehicles",
                                                  "4_vehicles", "5plus_vehicles"), start=1)}
        features.append({"type": "Feature", "id": geoid, "geometry": shape["geometry"], "properties": {
            "geoid": geoid, "name": data[geoid]["name"], "acs_vintage": "2016-2020 ACS 5-year",
            "geography_vintage": "2020 Census block groups (TIGER/Line 2020)",
            "population": population, "moe_population": acs_int(moe["B01003"][0]),
            "households": households, "moe_households": acs_int(moe["B11001"][0]),
            "vehicles_available_total": acs_int(est["B25046"][0]),
            "moe_vehicles_available_total": acs_int(moe["B25046"][0]),
            "households_no_vehicle": by_vehicles["households_0_vehicles"], **by_vehicles,
            "population_65_plus": sum(b01001[19:25]) + sum(b01001[43:49]),
            "moe_derived_sums": None, "moe_derived_sums_status": "not_computed",
            "moe_derived_sums_reason": "sums across ACS cells need an approximate MOE formula; cell MOEs are in raw/derived/acs2020-5yr-bg-subset.json",
            "aland_m2": int(shape["properties"]["ALAND"]), "awater_m2": int(shape["properties"]["AWATER"]),
            "tables": "B01001, B01003, B11001, B25044, B25046", "evidence_class": "observed",
            "source_id": "census-acs-2020-5yr-co", "geometry_source_id": "census-tiger-2020-bg-co",
        }})
    return feature_collection(features)


# --------------------------------------------------------------------------- traffic

def normalize_traffic(files: dict[str, bytes], table: dict) -> tuple[dict, list[dict]]:
    station_meta = {}
    for name, data in files.items():
        if "/stations-" in name:
            for station in load_json(data, name):
                station_meta[station["stationId"]] = station
    selected = table["cdot_stations"]
    stations = []
    observations = []
    for station_id in sorted(selected):
        meta = station_meta[station_id]
        stations.append({"type": "Feature", "id": f"cdot:{station_id}", "geometry": None, "properties": {
            "station_id": station_id, "route": meta["route"], "ref_point_begin": meta["begRef"],
            "ref_point_end": meta["endRef"], "description": meta["desc"], "city": meta["city"],
            "county": meta["county"], "type": "continuous" if meta["continuous"] else "short",
            "direction_codes": {"P": "primary direction", "S": "secondary direction"},
            "direction_compass_status": "unknown",
            "direction_reason": "OTIS defines only P = primary, S = secondary; compass direction is not stated",
            "lanes": None, "lanes_status": "unknown",
            "geometry_status": "unknown",
            "geometry_reason": "OTIS returns route reference points, not coordinates; not geocoded",
            "relevance": selected[station_id], "source_id": "cdot-otis", "evidence_class": "observed"}})
    for name in sorted(files):
        match = re.search(r"/daily/(\d{6})-(\d{4}-\d{2}-\d{2})\.json$", name)
        if not match:
            continue
        station_id, day = match.groups()
        if station_id not in selected:
            continue
        rows = load_json(files[name], name)
        if not rows:
            observations.append({"station_id": station_id, "local_date": day, "status": "missing",
                                 "reason": "OTIS returned no hourly records for this date", "source_file": name})
            continue
        for row in rows:
            for hour in range(24):
                raw = row[f"h{hour}"]
                if not re.fullmatch(r"\d{1,3}(,\d{3})*", raw):
                    raise SourceError(f"invalid count {raw!r} in {name}")
                start = datetime.fromisoformat(day).replace(hour=hour, tzinfo=LOCAL_ZONE)
                observations.append({
                    "station_id": station_id, "direction": row["dir"], "interval_start": utc_text(start),
                    "interval_start_local": start.isoformat(), "interval_s": 3600,
                    "interval_time_basis": "derived: OTIS hour columns h0-h23 read as local (America/Denver) clock hours; OTIS does not state the time zone",
                    "flow_veh": int(raw.replace(",", "")), "speed_kph": None, "occupancy_pct": None,
                    "pct_observed": None, "pct_observed_status": "unknown",
                    "evidence_class": "observed", "source_id": "cdot-otis", "source_file": name,
                })
    observations.sort(key=lambda o: (o["station_id"], o.get("interval_start", o.get("local_date")), o.get("direction", "")))
    return feature_collection(stations), observations


# --------------------------------------------------------------------------- package

def artifact(path: str, data: bytes, count: int | None = None) -> dict:
    item = {"path": path, "bytes": len(data), "sha256": sha256(data)}
    if count is not None:
        item["count"] = count
    return item


def build_files(inputs: dict[str, bytes]) -> dict[str, bytes]:
    """``inputs`` maps package paths under raw/ and curated/ to bytes."""
    events_table = load_json(inputs["curated/marshall_events_table.json"], "events table")
    calibration_table = load_json(inputs["curated/marshall_calibration_table.json"], "calibration table")
    shelters_table = load_json(inputs["curated/marshall_shelters_table.json"], "shelters table")
    sources_table = load_json(inputs["curated/marshall_sources_table.json"], "sources table")
    tiles = {k: v for k, v in inputs.items() if re.fullmatch(r"raw/osm/osm-roads-[0-9_.\-]+\.json", k)}
    nodes, edges, exits, road_quality = normalize_roads(tiles)
    events = normalize_events(events_table)
    zones = normalize_zones(events_table, inputs.get("raw/derived/everbridge-zones-digitized.geojson"))
    shelters = normalize_shelters(shelters_table, inputs.get("raw/osm/osm-facilities.json"), events)
    shelter_points = {f["id"]: f["geometry"] for f in shelters["features"] if f["geometry"]}
    for event in events:
        point = shelter_points.get(event["target"].get("shelter_id"))
        if point:
            event["geometry"] = point
            event["geocode_method"] = "shelter_location (normalized/shelters.geojson)"
    calibration = normalize_calibration(calibration_table)
    perimeters = normalize_perimeters(inputs["raw/feds-F2391.json"])
    detections = normalize_detections({k: v for k, v in inputs.items() if k.startswith("raw/derived/firms-subset-")})
    population = normalize_population(inputs["raw/derived/tiger2020-bg-subset.geojson"],
                                      inputs["raw/derived/acs2020-5yr-bg-subset.json"])
    crosswalk = normalize_crosswalk(zones, population)
    stations, observations = normalize_traffic({k: v for k, v in inputs.items() if k.startswith("raw/cdot-otis/")},
                                               sources_table)
    normalized = {
        "normalized/road_nodes.geojson": (nodes, len(nodes["features"])),
        "normalized/road_edges.geojson": (edges, len(edges["features"])),
        "normalized/exit_nodes.json": (exits, len(exits["exits"])),
        "normalized/evacuation_zones.geojson": (zones, len(zones["features"])),
        "normalized/shelters.geojson": (shelters, len(shelters["features"])),
        "normalized/calibration_targets.json": (calibration, len(calibration["targets"])),
        "normalized/fire_perimeters.geojson": (perimeters, len(perimeters["features"])),
        "normalized/fire_detections.geojson": (detections, len(detections["features"])),
        "normalized/population_units.geojson": (population, len(population["features"])),
        "normalized/traffic_stations.geojson": (stations, len(stations["features"])),
        "normalized/zone_population_crosswalk.json": (crosswalk, len(crosswalk["zones"])),
    }
    files = dict(inputs)
    counts = {}
    for path, (value, count) in normalized.items():
        files[path] = encoded_json(value)
        counts[path] = count
    files["normalized/events.jsonl"] = jsonl(events)
    counts["normalized/events.jsonl"] = len(events)
    files["normalized/traffic_observations.jsonl"] = jsonl(observations)
    counts["normalized/traffic_observations.jsonl"] = len(observations)

    hourly = [o for o in observations if "flow_veh" in o]
    geometry_ok = sum(f["geometry"] is not None for f in shelters["features"])
    quality = {
        "roads": road_quality,
        "event_count": len(events),
        "event_type_counts": dict(sorted(collections.Counter(e["type"] for e in events).items())),
        "events_by_evidence_class": dict(sorted(collections.Counter(e["evidence_class"] for e in events).items())),
        "zone_count": len(zones["features"]),
        "zones_with_geometry": sum(f["geometry"] is not None for f in zones["features"]),
        "shelter_count": len(shelters["features"]), "shelters_geocoded": geometry_ok,
        "population_block_groups": len(population["features"]),
        "population_total_in_intersecting_block_groups": sum(f["properties"]["population"] for f in population["features"]),
        "households_total_in_intersecting_block_groups": sum(f["properties"]["households"] for f in population["features"]),
        "traffic_hourly_observations": len(hourly),
        "traffic_missing_station_days": [(o["station_id"], o["local_date"]) for o in observations if o.get("status") == "missing"],
        "fire_detection_count": len(detections["features"]),
        "fire_perimeter_count": len(perimeters["features"]),
        "untimed_facts": [
            "Trailhead Fire ignited roughly one hour after the Eldorado Springs Fire (investigative summary p. 6); no clock time published.",
            "The two fires merged; investigators did not determine when or where (investigative summary p. 2).",
        ],
        "limitations": events_table["interpretation"],
    }
    files["quality.json"] = encoded_json(quality)
    files["sources.json"] = encoded_json(sources_table["sources"])
    version_material = b"".join(path.encode() + b"\0" + sha256(inputs[path]).encode() for path in sorted(inputs))
    version = sha256(version_material + NORMALIZER_VERSION.encode())[:16]
    layers = layer_status(counts, events, zones, shelters, population, hourly, detections, perimeters, sources_table)
    layers["zone_population_crosswalk"] = {"status": "present" if crosswalk["zones"] else "missing",
                                           "count": len(crosswalk["zones"]), "evidence_class": "derived",
                                           "method": crosswalk["method"]}
    manifest = {
        "schema_version": "0.1.0", "normalizer_version": NORMALIZER_VERSION, "incident_id": INCIDENT_ID,
        "incident_name": "Marshall Fire", "incident_identifiers": sources_table["incident_identifiers"],
        "package_version": version, "requested_bbox": list(BBOX), "bbox_justification": BBOX_JUSTIFICATION,
        "coordinate_reference_system": "OGC:CRS84", "coordinate_order": "longitude, latitude",
        "time_zone": "America/Denver", "utc_offset": "-07:00 (MST)", "focus_window_utc": list(FOCUS_WINDOW_UTC),
        "road_snapshot_at": SNAPSHOT_AT, "layers": layers,
        "evidence_classes": {"observed": "measured or official record", "reported": "news or official retrospective statement",
                             "reconstructed": "expert reconstruction", "derived": "deterministic transformation in this package"},
        "artifacts": [artifact(path, data, counts.get(path)) for path, data in sorted(files.items())],
    }
    files["manifest.json"] = encoded_json(manifest)
    return files


def layer_status(counts, events, zones, shelters, population, hourly, detections, perimeters, sources_table) -> dict:
    span = lambda items, key: [min(i[key] for i in items), max(i[key] for i in items)] if items else None
    layers = {name: {"status": "missing", "reason": reason}
              for name, reason in sources_table["missing_layers"].items()}
    layers["roads"] = {"status": "present", "snapshot_at": SNAPSHOT_AT,
                       "node_count": counts["normalized/road_nodes.geojson"],
                       "directed_edge_count": counts["normalized/road_edges.geojson"],
                       "coverage": "bounded pre-fire OSM drivable roads; completeness not verified"}
    layers["events"] = {"status": "partial", "count": len(events), "time_coverage_utc": span(events, "occurred_at"),
                        "coverage": "9 official Everbridge messages (18 events) and reviewed AAR timeline entries",
                        "missing": "road closure/reopening times, order lifts, re-entry, per-street door-to-door timing; OSM edge matches unresolved"}
    with_geometry = sum(f["geometry"] is not None for f in zones["features"])
    layers["evacuation_zones"] = {"status": "partial", "count": len(zones["features"]), "with_geometry": with_geometry,
                                  "coverage": "13 Everbridge launch areas digitized from the county GeoPDF (derived geometry)",
                                  "missing": "polygons for Louisville Zones 1-4 named in the AAR; any pre-existing standing zone system"}
    layers["population_units"] = {"status": "present", "count": len(population["features"]),
                                  "acs_vintage": "2016-2020 ACS 5-year", "coverage": "2020 block groups intersecting the bbox"}
    layers["traffic_observations"] = {"status": "partial", "hourly_count_records": len(hourly),
                                      "time_coverage_utc": span(hourly, "interval_start"),
                                      "coverage": "CDOT OTIS continuous stations; hourly volume only",
                                      "missing": "speed, occupancy, data-quality percent, station coordinates, compass direction"}
    layers["calibration_targets"] = {"status": "present", "count": counts["normalized/calibration_targets.json"]}
    geocoded = sum(f["geometry"] is not None for f in shelters["features"])
    layers["shelters"] = {"status": "present" if geocoded == len(shelters["features"]) else "partial",
                          "count": len(shelters["features"]), "geocoded": geocoded,
                          "missing": "capacities and occupancy reports are not published"}
    layers["fire_perimeters"] = {"status": "present", "count": len(perimeters["features"]),
                                 "time_coverage_utc": span([f["properties"] for f in perimeters["features"]], "t_utc"),
                                 "coverage": "NASA VEDA FEDS F2391 half-day cumulative perimeters"}
    layers["fire_detections"] = {"status": "present", "count": len(detections["features"]),
                                 "time_coverage_utc": span([f["properties"] for f in detections["features"]], "acquired_at"),
                                 "coverage": "FIRMS MODIS C6.1, VIIRS S-NPP and NOAA-20 375 m, bbox and 2021-12-29..2022-01-02 UTC"}
    return dict(sorted(layers.items()))


def collect_inputs(stage: Path) -> dict[str, bytes]:
    inputs = {}
    for path in sorted(stage.rglob("*")):
        if path.is_file():
            relative = path.relative_to(stage).as_posix()
            if not relative.startswith("raw/"):
                raise SourceError(f"stage may only contain raw/ files: {relative}")
            inputs[relative] = path.read_bytes()
    for package_path, tool_path in CURATED_TABLES.items():
        inputs[package_path] = tool_path.read_bytes()
    return inputs


def write_package(files: dict[str, bytes], output_root: Path) -> Path:
    version = json.loads(files["manifest.json"])["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    (output_root / INCIDENT_ID).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="marshall-", dir=output_root / INCIDENT_ID) as temp_dir:
        temporary = Path(temp_dir) / "pkg"
        for name, data in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        shutil.move(str(temporary), str(target))
    return target


def verify(package: Path) -> dict:
    manifest = json.loads((package / "manifest.json").read_bytes())
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("package identity or normalizer version mismatch")
    listed = {item["path"] for item in manifest["artifacts"]}
    on_disk = {p.relative_to(package).as_posix() for p in package.rglob("*") if p.is_file()} - {"manifest.json"}
    if listed != on_disk:
        raise SourceError(f"package files differ from manifest: {sorted(listed ^ on_disk)[:5]}")
    for item in manifest["artifacts"]:
        data = (package / item["path"]).read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
    inputs = {path: (package / path).read_bytes() for path in sorted(listed)
              if path.startswith(("raw/", "curated/"))}
    rebuilt = build_files(inputs)
    if set(rebuilt) != listed | {"manifest.json"}:
        raise SourceError("package artifact list differs from reproducible build")
    for name, data in rebuilt.items():
        if (package / name).read_bytes() != data:
            raise SourceError(f"offline normalization mismatch: {name}")
    if package.name != manifest["package_version"]:
        raise SourceError("package directory and version differ")
    quality = json.loads((package / "quality.json").read_bytes())
    return {"package_version": manifest["package_version"],
            "layers": {k: v["status"] for k, v in manifest["layers"].items()},
            "roads": {k: quality["roads"][k] for k in ("node_count", "directed_edge_count",
                                                       "largest_strongly_connected_component_nodes", "exit_node_count")},
            "event_count": quality["event_count"], "traffic_hourly_observations": quality["traffic_hourly_observations"],
            "fire_detection_count": quality["fire_detection_count"], "population_block_groups": quality["population_block_groups"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, help="directory whose raw/ tree holds downloaded and extracted inputs")
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
    elif args.stage:
        print(write_package(build_files(collect_inputs(args.stage)), args.output_root))
    else:
        parser.error("--stage or --verify-package is required")


if __name__ == "__main__":
    main()
