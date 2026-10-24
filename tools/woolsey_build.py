"""Build an immutable Woolsey Fire (2018) evacuation data package.

Layers: pre-fire OSM roads (attic snapshot, ten Overpass tiles), curated event
timeline (Citygate AAR, unified-command bulletins, CPUC), shelters, published
calibration facts, ACS 2013-2017 block-group population, FEDS perimeters and
FIRMS detections. Stdlib Python plus curl only.

Typical use (inputs directory lives outside the repository):

    python3.12 -m tools.woolsey_build fetch-osm --inputs DIR
    python3.12 -m tools.woolsey_build fetch-feds --inputs DIR
    python3.12 -m tools.woolsey_build extract-firms --inputs DIR --modis CSV --viirs CSV
    python3.12 -m tools.woolsey_build extract-acs --inputs DIR --acs-dir DIR --tiger ZIP
    python3.12 -m tools.woolsey_build build --inputs DIR
    python3.12 -m tools.woolsey_build --verify-package data/incidents/woolsey-2018-evacuation/<version>
"""

from __future__ import annotations

import argparse
import collections
import csv
import gzip
import io
import json
import math
import re
import shutil
import struct
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.build_camp_evacuation import (
    SourceError,
    artifact,
    direction,
    encoded_json,
    largest_scc,
    permitted,
    segment_length_m,
    sha256,
    tagged_lanes,
    tagged_speed,
)


INCIDENT_ID = "woolsey-2018-evacuation"
NORMALIZER_VERSION = "woolsey-1"
SNAPSHOT_AT = "2018-11-08T00:00:00Z"
# west, south, east, north. Contains the final FEDS F17192 perimeter extent
# [-118.987, 34.013, -118.646, 34.281] with margin for the evacuated communities
# (Simi Valley, Thousand Oaks, Newbury Park, West Hills/Woodland Hills, Topanga,
# Malibu) and the US-101 / SR-1 / SR-23 / SR-118 / SR-27 egress corridors.
BBOX = (-119.05, 33.98, -118.55, 34.30)
TILES = (  # south, west, north, east (Overpass order); northern half split again after HTTP 504s
    (33.98, -119.05, 34.14, -118.80),
    (33.98, -118.80, 34.14, -118.55),
    (34.14, -119.05, 34.22, -118.925),
    (34.14, -118.925, 34.22, -118.80),
    (34.22, -119.05, 34.30, -118.925),
    (34.22, -118.925, 34.30, -118.80),
    (34.14, -118.80, 34.22, -118.675),
    (34.14, -118.675, 34.22, -118.55),
    (34.22, -118.80, 34.30, -118.675),
    (34.22, -118.675, 34.30, -118.55),
)
OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter"
OVERPASS_MIRRORS = (OVERPASS_URL, "https://overpass-api.de/api/interpreter")
USER_AGENT = "crisistwin-data-acquisition/0.1"
HIGHWAY_REGEX = ("^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|"
                 "secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$")
SHELTER_QUERY_BBOX = (33.90, -119.20, 34.35, -118.30)
FEDS_URL = "https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items"
FEDS_FIRE_ID = "F17192"
FEDS_DATETIME = "2018-11-01T00:00:00Z/2018-12-01T00:00:00Z"
FIRMS_DATES = ("2018-11-08", "2018-11-21")  # inclusive UTC acquisition dates
FIRMS_FILES = {
    "modis": ("https://firms.modaps.eosdis.nasa.gov/data/country/modis/2018/modis_2018_United_States.csv",
              "raw/firms-modis-2018-subset.csv"),
    "viirs-snpp": ("https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2018/viirs-snpp_2018_United_States.csv",
                   "raw/firms-viirs-snpp-2018-subset.csv"),
}
ACS_BASE = ("https://www2.census.gov/programs-surveys/acs/summary_file/2017/data/"
            "5_year_seq_by_state/California/Tracts_Block_Groups_Only/")
ACS_COUNTIES = ("037", "111")  # Los Angeles, Ventura
# table -> (sequence, 0-based start column in the sequence file, cell count)
ACS_TABLES = {
    "B01001": ("0002", 6, 49),
    "B01003": ("0003", 129, 1),
    "B11001": ("0036", 6, 9),
    "B25044": ("0105", 113, 15),
    "B25046": ("0105", 147, 3),
}
TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2017/BG/tl_2017_06_bg.zip"
TOOLS_DIR = Path(__file__).parent
CURATED = {
    "curated/citygate-timeline.json": TOOLS_DIR / "woolsey_citygate_timeline.json",
    "curated/lacofd-bulletins.json": TOOLS_DIR / "woolsey_lacofd_bulletins.json",
    "curated/shelters.json": TOOLS_DIR / "woolsey_shelters_table.json",
    "curated/facts.json": TOOLS_DIR / "woolsey_facts_table.json",
}
PST = timezone(timedelta(hours=-8))
LAYER_NAMES = (
    "roads", "events", "evacuation_zones", "population_units", "traffic_observations",
    "calibration_targets", "shelters", "fire_progression_reconstructed", "fire_perimeters",
    "fire_detections", "displacement", "terrain_grid", "buildings", "street_imagery",
    "media_evidence",
)
EXIT_DESTINATIONS = {  # (OSM ref, boundary side) -> destination label; derived lookup
    ("US 101", "west"): "US 101 toward Camarillo / Oxnard",
    ("US 101", "east"): "US 101 toward the San Fernando Valley / Los Angeles",
    ("CA 1", "west"): "SR 1 (PCH) toward Oxnard",
    ("CA 1", "east"): "SR 1 (PCH) toward Santa Monica",
    ("CA 118", "east"): "SR 118 toward the San Fernando Valley",
    ("CA 118", "west"): "SR 118 toward Moorpark",
    ("CA 118", "north"): "SR 118 toward Moorpark",
    ("CA 23", "north"): "SR 23 toward Moorpark",
    ("CA 27", "north"): "SR 27 (Topanga Canyon Blvd) toward Chatsworth",
}


# ---------------------------------------------------------------- helpers

def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def now_text() -> str:
    return utc_text(datetime.now(timezone.utc))


def curl(args: list[str], timeout_s: int) -> bytes:
    result = subprocess.run(
        ["curl", "--http1.1", "--fail", "--silent", "--show-error", "--location", "--max-time",
         str(timeout_s), *args], capture_output=True, check=False, timeout=timeout_s + 30)
    if result.returncode:
        raise SourceError(f"download failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def load_json(data: bytes, label: str) -> object:
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"{label} is not valid JSON: {exc}") from exc


def fc(features: list[dict], **extra: object) -> dict:
    return {"type": "FeatureCollection", **extra, "features": features}


def bbox_text(box: tuple[float, float, float, float]) -> str:
    texts = (f"{value:.3f}" for value in box)  # 2 decimals unless a third is needed
    return ",".join(t[:-1] if t.endswith("0") else t for t in texts)


def road_tile_query(tile: tuple[float, float, float, float]) -> str:
    return (f'[out:json][timeout:240][date:"{SNAPSHOT_AT}"];'
            f'way["highway"~"{HIGHWAY_REGEX}"]({bbox_text(tile)});(._;>;);out body;')


def shelter_query(table: dict) -> str:
    patterns = sorted({row["osm_name_pattern"].strip("^$") for row in table["shelters"]})
    return (f'[out:json][timeout:120][date:"{SNAPSHOT_AT}"];'
            f'nwr["name"~"^({"|".join(patterns)})$"]({bbox_text(SHELTER_QUERY_BBOX)});out center tags;')


def overpass(query: str, url: str = OVERPASS_URL, attempts: int = 5) -> bytes:
    if url not in OVERPASS_MIRRORS:
        raise SourceError(f"unsupported Overpass mirror {url}")
    last = None
    for attempt in range(attempts):
        try:
            raw = curl(["-A", USER_AGENT, "--data-urlencode", f"data={query}", url], 400)
            source = load_json(raw, "Overpass response")
            if not isinstance(source, dict) or source.get("remark") or "elements" not in source:
                raise SourceError(f"Overpass failure remark: {source.get('remark') if isinstance(source, dict) else source}")
            return raw
        except SourceError as exc:
            last = exc
            time.sleep(60 * (attempt + 1))
    raise SourceError(f"Overpass query failed after {attempts} attempts: {last}")


# ---------------------------------------------------------------- roads

def merge_osm(raws: list[bytes]) -> tuple[dict[int, tuple[float, float]], list[dict], list[str]]:
    nodes: dict[int, tuple[float, float]] = {}
    ways: dict[int, dict] = {}
    bases = []
    for index, raw in enumerate(raws, 1):
        source = load_json(raw, f"OSM tile {index}")
        if not isinstance(source, dict) or not isinstance(source.get("elements"), list) or source.get("remark"):
            raise SourceError(f"OSM tile {index} is not a complete Overpass response")
        bases.append(source.get("osm3s", {}).get("timestamp_osm_base"))
        for element in source["elements"]:
            if not isinstance(element, dict) or type(element.get("id")) is not int:
                raise SourceError("OSM element lacks an integer ID")
            if element.get("type") == "node":
                coord = (element.get("lon"), element.get("lat"))
                if not all(type(n) in (int, float) and math.isfinite(n) for n in coord):
                    raise SourceError(f"OSM node {element['id']} has invalid coordinates")
                if nodes.setdefault(element["id"], coord) != coord:
                    raise SourceError(f"OSM node {element['id']} differs between tiles")
            elif element.get("type") == "way":
                if not isinstance(element.get("nodes"), list) or len(element["nodes"]) < 2 \
                        or not isinstance(element.get("tags"), dict):
                    raise SourceError(f"OSM way {element['id']} is unusable")
                key = (tuple(element["nodes"]), json.dumps(element["tags"], sort_keys=True))
                previous = ways.setdefault(element["id"], element)
                if (tuple(previous["nodes"]), json.dumps(previous["tags"], sort_keys=True)) != key:
                    raise SourceError(f"OSM way {element['id']} differs between tiles")
    if not nodes or not ways:
        raise SourceError("OSM extract is empty")
    if any(node_id not in nodes for way in ways.values() for node_id in way["nodes"]):
        raise SourceError("OSM extract is incomplete: a way references an absent node")
    return nodes, [ways[key] for key in sorted(ways)], bases


def normalize_roads(raws: list[bytes]) -> tuple[dict, dict, dict, dict]:
    nodes, ways, bases = merge_osm(raws)
    selected = [way for way in ways if permitted(way["tags"]) and direction(way["tags"]) != "unknown"]
    membership: collections.Counter[int] = collections.Counter()
    for way in selected:
        membership.update(set(way["nodes"]))
    west, south, east, north = BBOX

    def inside(coord: tuple[float, float]) -> bool:
        return west <= coord[0] <= east and south <= coord[1] <= north

    used: set[int] = set()
    edges: list[dict] = []
    exits: dict[int, dict] = {}
    for way in selected:
        ids, tags = way["nodes"], way["tags"]
        cuts = sorted({0, len(ids) - 1} | {i for i, n in enumerate(ids) if membership[n] > 1})
        road_direction = direction(tags)
        travels = ("forward", "reverse") if road_direction == "both" else (road_direction,)
        speed, speed_status = tagged_speed(tags)
        for seg_index, (a, b) in enumerate(zip(cuts, cuts[1:])):
            seg_ids = ids[a:b + 1]
            coords = [nodes[n] for n in seg_ids]
            length_m = segment_length_m(coords)
            if len(seg_ids) < 2 or length_m <= 0:
                continue
            used.update((seg_ids[0], seg_ids[-1]))
            for travel in travels:
                ordered = seg_ids if travel == "forward" else seg_ids[::-1]
                lanes, lanes_status = tagged_lanes(tags, travel, road_direction != "both")
                edge_id = f"osm-way:{way['id']}:{seg_index}:{'f' if travel == 'forward' else 'r'}"
                edges.append({"type": "Feature", "id": edge_id,
                              "geometry": {"type": "LineString", "coordinates": [list(nodes[n]) for n in ordered]},
                              "properties": {
                                  "edge_id": edge_id, "from_node": f"osm-node:{ordered[0]}",
                                  "to_node": f"osm-node:{ordered[-1]}", "osm_way_id": way["id"],
                                  "name": tags.get("name"), "ref": tags.get("ref"), "highway": tags["highway"],
                                  "oneway": road_direction != "both", "lanes": lanes, "lanes_status": lanes_status,
                                  "maxspeed_kph": speed, "maxspeed_status": speed_status, "length_m": length_m,
                                  "bridge": tags.get("bridge") not in (None, "no"),
                                  "tunnel": tags.get("tunnel") not in (None, "no"),
                                  "source_id": "osm-overpass-attic-2018-11-08", "evidence_class": "observed"}})
            for node_id in (seg_ids[0], seg_ids[-1]):
                if inside(nodes[node_id]) or not any(inside(c) for c in coords):
                    continue
                lon, lat = nodes[node_id]
                side = min({"west": abs(lon - west), "east": abs(lon - east),
                            "south": abs(lat - south), "north": abs(lat - north)}.items(), key=lambda kv: kv[1])[0]
                refs = [r.strip() for r in (tags.get("ref") or "").split(";") if r.strip()]
                label = next((EXIT_DESTINATIONS[(r, side)] for r in refs if (r, side) in EXIT_DESTINATIONS), None)
                exits.setdefault(node_id, {
                    "node_id": f"osm-node:{node_id}", "boundary": side, "road_name": tags.get("name"),
                    "road_ref": tags.get("ref"), "highway": tags["highway"],
                    "destination_direction": side, "destination_name": label,
                    "destination_name_method": "derived_ref_side_lookup" if label else None,
                    "destination_name_status": "derived" if label else "unknown"})
    if not edges:
        raise SourceError("road normalization produced no directed edges")
    edges.sort(key=lambda feature: feature["id"])
    node_features = [{"type": "Feature", "id": f"osm-node:{n}",
                      "geometry": {"type": "Point", "coordinates": list(nodes[n])},
                      "properties": {"node_id": f"osm-node:{n}", "osm_node_id": n,
                                     "source_id": "osm-overpass-attic-2018-11-08", "evidence_class": "observed"}}
                     for n in sorted(used)]
    coords = [nodes[n] for n in used]
    quality = {
        "source_way_count": len(ways), "selected_way_count": len(selected),
        "node_count": len(node_features), "directed_edge_count": len(edges),
        "largest_strongly_connected_component_nodes": largest_scc(used, edges),
        "exit_node_count": len(exits),
        "exit_nodes_with_destination_name": sum(1 for e in exits.values() if e["destination_name"]),
        "actual_bbox": [min(x for x, _ in coords), min(y for _, y in coords),
                        max(x for x, _ in coords), max(y for _, y in coords)],
        "osm_base_timestamps": bases, "snapshot_at": SNAPSHOT_AT,
        "limitations": [
            "OSM is community mapped and may omit roads or 2018 access restrictions.",
            "Service roads were not requested; private/no-access ways are excluded.",
            "Unknown directional lane counts and speeds remain null.",
            "Exit nodes are geometric boundary crossings; only major-route exits get a derived destination label.",
            "No turn restrictions or signal timings.",
        ],
    }
    return fc(node_features), fc(edges), {"exits": [exits[n] for n in sorted(exits)]}, quality


# ---------------------------------------------------------------- shelters

def normalize_shelters(table: dict, osm_raw: bytes) -> dict:
    source = load_json(osm_raw, "OSM shelter response")
    elements = source.get("elements") if isinstance(source, dict) else None
    if not isinstance(elements, list) or source.get("remark"):
        raise SourceError("OSM shelter response is incomplete")
    features = []
    for row in table["shelters"]:
        pattern = re.compile(row["osm_name_pattern"])
        wanted = row.get("osm_element")
        matches = [e for e in elements if pattern.fullmatch(e.get("tags", {}).get("name", ""))]
        chosen = None
        if wanted:
            chosen = next((e for e in matches if f"{e['type']}/{e['id']}" == wanted), None)
            if chosen is None:
                raise SourceError(f"{row['shelter_id']}: reviewed OSM element {wanted} absent from response")
        point = None
        if chosen:
            point = [chosen["lon"], chosen["lat"]] if chosen["type"] == "node" else \
                [chosen["center"]["lon"], chosen["center"]["lat"]]
        opened = row.get("opened_at_local_date")
        props = {
            "shelter_id": row["shelter_id"], "name": row["name"], "kind": row["kind"],
            "animals": row.get("animals"), "operator": row.get("operator"), "county": row["county"],
            "address_as_written": row.get("address_as_written"),
            "opened_at": None, "opened_at_status": "unknown" if not opened else "day_only",
            "opened_from": utc_text(datetime.fromisoformat(opened).replace(tzinfo=PST)) if opened else None,
            "opened_to": utc_text(datetime.fromisoformat(opened).replace(tzinfo=PST) + timedelta(days=1)) if opened else None,
            "opened_at_as_written": row.get("opened_at_as_written"), "opened_source": row.get("opened_source"),
            "first_listed_at": utc_text(datetime.fromisoformat(row["first_listed_at_local"])),
            "capacity_persons": None, "capacity_persons_status": "unknown",
            "capacity_persons_reason": "no capacity published in the cited sources",
            "status_reports": [{**r, "at": utc_text(datetime.fromisoformat(r["at_local"]))} for r in row["status_reports"]],
            "occupancy_reports": [{**r, "at": utc_text(datetime.fromisoformat(r["at_local"]))}
                                  for r in row.get("occupancy_reports", [])],
            "osm_element": f"{chosen['type']}/{chosen['id']}" if chosen else None,
            "osm_candidate_count": len(matches),
            "geocode_method": "osm_named_feature_2018_snapshot" if chosen else "unresolved",
            "in_package_bbox": bool(point) and BBOX[0] <= point[0] <= BBOX[2] and BBOX[1] <= point[1] <= BBOX[3],
            "notes": row.get("notes"), "evidence_class": "reported",
            "source_id": "redcross-2018-11-09 / lacofd-incident-updates-2018 / citygate-aar-2019",
        }
        features.append({"type": "Feature", "id": row["shelter_id"],
                         "geometry": {"type": "Point", "coordinates": point} if point else None,
                         "properties": props})
    return fc(features)


# ---------------------------------------------------------------- events

def citygate_events(table: dict) -> list[dict]:
    url, offset = table["source_url"], table["pdf_page_offset"]
    events = []
    for row in table["events"]:
        qualifier = row["time_qualifier"]
        day = datetime.fromisoformat(row["date_local"]).replace(tzinfo=PST)
        window_status = None
        if qualifier in ("exact", "approximate"):
            hour, minute = map(int, row["time_local"].split(":"))
            at = day + timedelta(hours=hour, minutes=minute)
            occurred_at = utc_text(at)
            occurred_from = occurred_to = occurred_at if qualifier == "exact" else None
            precision = "minute" if qualifier == "exact" else "approximate"
            if qualifier == "approximate":
                window_status = "unknown: source marks the time approximate without a window"
        elif qualifier == "day":
            occurred_from, occurred_to = utc_text(day), utc_text(day + timedelta(days=1))
            occurred_at, precision = occurred_to, "day"  # latest bound: true by end of the local day
        elif qualifier == "untimed":
            low, high = (datetime.fromisoformat(v).replace(tzinfo=PST) for v in row["bounded_by_local"])
            occurred_from, occurred_to = utc_text(low), utc_text(high)
            occurred_at, precision = occurred_to, "approximate"  # latest bound
            window_status = "bounded by adjacent time-stamped Citygate entries (source states untimed entries are placed chronologically)"
        else:
            raise SourceError(f"{row['id']}: unknown time qualifier {qualifier}")
        is_alert = row["type"] == "alert_sent"
        pdf_page = row["printed_page"] + offset
        where = (f"Section 3 timeline, Significant Event {row['se']}" if row.get("se")
                 else f"Section {row.get('section')}")
        extras = {k: v for k, v in row.items() if k not in {
            "id", "se", "section", "printed_page", "date_local", "time_local", "time_qualifier",
            "local_time_as_written", "type", "target", "description", "quote", "evidence_class",
            "bounded_by_local", "time_role"}}
        events.append({
            "event_id": row["id"], "type": row["type"], "occurred_at": occurred_at,
            "occurred_from": occurred_from, "occurred_to": occurred_to, "time_precision": precision,
            **({"occurred_window_status": window_status} if window_status else {}),
            "time_role": row.get("time_role", "time stamped in the after-action timeline")
            + ("; occurred_at is the latest bound of occurred_from..occurred_to" if qualifier in ("day", "untimed") else ""),
            "available_at": occurred_at if is_alert and qualifier == "exact" else None,
            "available_at_status": "public message send time" if is_alert and qualifier == "exact" else "unknown",
            "local_time_as_written": f"{row['date_local']} {row['local_time_as_written']}",
            "target": row["target"], "geometry": None, "geocode_method": "unresolved",
            "description": row["description"], "quote": row["quote"],
            "evidence_class": row["evidence_class"], "source_id": table["source_id"],
            "source_locator": f"{url}#page={pdf_page}; {where}; p. {row['printed_page']}",
            **extras})
    return events


def bulletin_events(table: dict) -> list[dict]:
    events = []
    for row in table["events"]:
        bulletin = table["bulletins"][row["bulletin"]]
        report = datetime.fromisoformat(bulletin["report_time_local"])
        created = datetime.fromisoformat(bulletin["pdf_creation_date_local"])
        stated = row.get("stated_time_local")
        if stated:
            at = datetime.fromisoformat(stated)
            role = ("time stated in the bulletin; the PDF was created before this time, so it is an "
                    "announced time, not an observed transition") if created < at else "time stated in the bulletin"
        else:
            at = report
            role = "condition listed as in effect at the bulletin report time; onset unknown"
        words = row["as_written"].split()
        events.append({
            "event_id": row["id"], "type": row["type"], "occurred_at": utc_text(at),
            "occurred_from": None, "occurred_to": None, "time_precision": "minute",
            "occurred_window_status": "unknown: status bulletins do not state onset or end",
            "time_role": role, "bulletin_report_time": utc_text(report),
            "bulletin_pdf_creation_time": utc_text(created),
            "available_at": None, "available_at_status": "unknown: bulletin release time not recorded",
            "local_time_as_written": f"{report.strftime('%m/%d/%Y')} bulletin {report.strftime('%H:%M')}"
                                     + (f"; stated {datetime.fromisoformat(stated).strftime('%H%M')}" if stated else ""),
            "target": row["target"], "geometry": None, "geocode_method": "unresolved",
            "description": f"{row['section']} in {row['bulletin']} bulletin: {row['as_written']}",
            "quote": row["as_written"] if len(words) <= 25 else " ".join(words[:25]),
            "evidence_class": "reported", "source_id": table["source_id"],
            "source_locator": f"{bulletin['url']}#page={row['page']}; section '{row['section']}'",
            **({"note": row["note"]} if row.get("note") else {})})
    return events


def facts_events(facts: dict) -> list[dict]:
    incident = facts["incident"]
    at = utc_text(datetime.fromisoformat(incident["related_utility_event_local"]))
    return [{
        "event_id": "woolsey-cpuc-circuit-lockout", "type": "infrastructure_failure",
        "infrastructure": "power", "occurred_at": at, "occurred_from": at, "occurred_to": at,
        "time_precision": "minute", "time_role": "relay/lockout time recorded by the utility",
        "available_at": None, "available_at_status": "unknown",
        "local_time_as_written": "2018-11-08 1422 hours",
        "target": {"place_name": "Santa Susana Field Laboratory area (Edison Big Rock 16 kV circuit)"},
        "geometry": None, "geocode_method": "unresolved",
        "description": "Edison 16 kV Big Rock circuit out of Chatsworth substation relayed and locked out two minutes before the first fire report.",
        "quote": "the Edison 16 kV Big Rock circuit out of Chatsworth substation relayed and locked out",
        "evidence_class": "observed", "source_id": "cpuc-sed-2021",
        "source_locator": f"{facts['sources']['cpuc-sed-2021']['url']}#page=3; I. Summary of Incident; p. 1"}]


def normalize_events(citygate: dict, bulletins: dict, facts: dict, shelters: dict) -> list[dict]:
    events = citygate_events(citygate) + bulletin_events(bulletins) + facts_events(facts)
    ids = [e["event_id"] for e in events]
    if len(ids) != len(set(ids)):
        raise SourceError("duplicate event IDs")
    located = {f["id"]: f["geometry"] for f in shelters["features"]}
    for event in events:
        shelter_id = event["target"].get("shelter_id")
        if shelter_id:
            if shelter_id not in located:
                raise SourceError(f"{event['event_id']}: unknown shelter {shelter_id}")
            if located[shelter_id]:
                event["geometry"] = located[shelter_id]
                event["geocode_method"] = "shelter_layer_location"
        if event["quote"] is not None and len(event["quote"].split()) > 25:
            raise SourceError(f"{event['event_id']}: quote exceeds 25 words")
    events.sort(key=lambda e: (e["occurred_at"], e["event_id"]))
    return events


# ---------------------------------------------------------------- fire

def normalize_feds(raw: bytes) -> dict:
    source = load_json(raw, "FEDS response")
    features = []
    for feature in source.get("features", []):
        props = feature.get("properties", {})
        if props.get("fireid") != FEDS_FIRE_ID:
            raise SourceError("FEDS response contains another fire ID")
        local = datetime.fromisoformat(props["t"]).replace(tzinfo=PST)
        features.append({"type": "Feature", "id": f"feds-{FEDS_FIRE_ID}-{props['t']}",
                         "geometry": feature["geometry"],
                         "properties": {**{k: props[k] for k in sorted(props)},
                                        "snapshot_local_time": props["t"], "snapshot_at": utc_text(local),
                                        "time_precision": "half_day", "farea_unit": "km2",
                                        "available_at": None, "available_at_status": "unknown (retrospective archive)",
                                        "evidence_class": "reconstructed",
                                        "method": "NASA FEDS satellite fire-event tracking (VIIRS active fire); cumulative perimeter",
                                        "source_id": "nasa-veda-feds"}})
    features.sort(key=lambda f: f["properties"]["t"])
    if not features or len({f["properties"]["t"] for f in features}) != len(features):
        raise SourceError("FEDS perimeters are empty or have duplicate times")
    return fc(features)


def normalize_firms(raw: bytes, product: str) -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    out = []
    for row in rows:
        lon, lat = float(row["longitude"]), float(row["latitude"])
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]
                and FIRMS_DATES[0] <= row["acq_date"] <= FIRMS_DATES[1]):
            raise SourceError(f"FIRMS {product} subset row outside extraction bounds")
        hhmm = row["acq_time"].zfill(4)
        at = datetime.fromisoformat(f"{row['acq_date']}T{hhmm[:2]}:{hhmm[2:]}:00+00:00")
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"product": product, "acquired_at": utc_text(at), "time_precision": "minute",
                                   "satellite": row["satellite"], "instrument": row["instrument"],
                                   "confidence": row["confidence"], "frp_mw": float(row["frp"]),
                                   "brightness_k": float(row.get("brightness") or row.get("bright_ti4")),
                                   "scan_km": float(row["scan"]), "track_km": float(row["track"]),
                                   "daynight": row["daynight"], "type": row["type"], "version": row["version"],
                                   "incident_attribution": "unattributed: bbox subset may include the Hill Fire and other heat sources",
                                   "evidence_class": "observed", "source_id": f"nasa-firms-{product}-2018"}})
    return out


def extract_firms(full: bytes) -> bytes:
    text = full.decode("utf-8")
    lines = text.splitlines(keepends=True)
    header = lines[0]
    columns = header.strip().split(",")
    ilat, ilon, idate = columns.index("latitude"), columns.index("longitude"), columns.index("acq_date")
    kept = [header]
    for line in lines[1:]:
        parts = line.rstrip("\r\n").split(",")
        lon, lat = float(parts[ilon]), float(parts[ilat])
        if BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3] and FIRMS_DATES[0] <= parts[idate] <= FIRMS_DATES[1]:
            kept.append(line)
    return "".join(kept).encode()


# ---------------------------------------------------------------- population

def read_dbf(data: bytes) -> list[dict]:
    count, header_len, record_len = struct.unpack("<xxxxIHH", data[:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode()
        fields.append((name, data[pos + 16]))
        pos += 32
    records = []
    for i in range(count):
        start = header_len + i * record_len + 1
        rec, offset = {}, 0
        for name, length in fields:
            rec[name] = data[start + offset:start + offset + length].decode("utf-8").strip()
            offset += length
        records.append(rec)
    return records


def ring_area(ring: list[list[float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2


def ring_bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_contains(outer: tuple, inner: tuple) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def read_shp_polygons(data: bytes) -> list[tuple[list[float], list]]:
    out = []
    pos = 100
    while pos < len(data):
        _, content_words = struct.unpack(">ii", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + content_words * 2]
        pos += 8 + content_words * 2
        shape_type = struct.unpack("<i", body[:4])[0]
        if shape_type == 0:
            out.append(([], []))
            continue
        if shape_type != 5:
            raise SourceError(f"unexpected shapefile shape type {shape_type}")
        box = list(struct.unpack("<4d", body[4:36]))
        nparts, npoints = struct.unpack("<ii", body[36:44])
        parts = list(struct.unpack(f"<{nparts}i", body[44:44 + 4 * nparts])) + [npoints]
        base = 44 + 4 * nparts
        pts = [list(struct.unpack("<2d", body[base + 16 * i:base + 16 * i + 16])) for i in range(npoints)]
        rings = [pts[parts[i]:parts[i + 1]] for i in range(nparts)]
        outers = [ring for ring in rings if ring_area(ring) < 0]  # shapefile exterior = clockwise
        holes = [ring for ring in rings if ring_area(ring) >= 0]
        polygons: list[list] = [[ring] for ring in outers]
        for hole in holes:
            hb = ring_bbox(hole)
            owners = [p for p in polygons if bbox_contains(ring_bbox(p[0]), hb)]
            if owners:
                min(owners, key=lambda p: abs(ring_area(p[0]))).append(hole)
            else:  # counter-clockwise ring with no enclosing exterior: keep as its own polygon
                polygons.append([hole])
        # RFC 7946 orientation: exterior counter-clockwise, holes clockwise.
        geometry = [[ring if (ring_area(ring) > 0) == (k == 0) else ring[::-1] for k, ring in enumerate(polygon)]
                    for polygon in polygons]
        out.append((box, geometry))
    return out


def extract_acs(acs_dir: Path, tiger_zip: Path) -> tuple[bytes, bytes, dict]:
    with zipfile.ZipFile(tiger_zip) as archive:
        records = read_dbf(archive.read("tl_2017_06_bg.dbf"))
        shapes = read_shp_polygons(archive.read("tl_2017_06_bg.shp"))
        prj = archive.read("tl_2017_06_bg.prj").decode()
    if len(records) != len(shapes):
        raise SourceError("TIGER dbf/shp record counts differ")
    west, south, east, north = BBOX
    features = []
    for rec, (box, polygons) in zip(records, shapes):
        if rec["COUNTYFP"] not in ACS_COUNTIES or not polygons:
            continue
        if box[0] > east or box[2] < west or box[1] > north or box[3] < south:
            continue
        features.append({"type": "Feature", "id": rec["GEOID"],
                         "geometry": {"type": "MultiPolygon", "coordinates": polygons},
                         "properties": {k: rec[k] for k in ("GEOID", "STATEFP", "COUNTYFP", "TRACTCE", "BLKGRPCE",
                                                              "ALAND", "AWATER", "INTPTLAT", "INTPTLON")}})
    features.sort(key=lambda f: f["id"])
    geoids = {f["id"] for f in features}
    logrec: dict[str, str] = {}
    with open(acs_dir / "g20175ca.csv", encoding="latin-1", newline="") as handle:
        for row in csv.reader(handle):
            if row[2] == "150" and row[48][7:] in geoids:
                logrec[row[4]] = row[48][7:]
    if set(logrec.values()) != geoids:
        raise SourceError("ACS geography file lacks some selected block groups")
    values: dict[str, dict] = {geoid: {"logrecno": rec, "estimate": {}, "moe": {}} for rec, geoid in logrec.items()}
    for table, (seq, start, cells) in sorted(ACS_TABLES.items()):
        with zipfile.ZipFile(acs_dir / f"20175ca{seq}000.zip") as archive:
            for kind, prefix in (("estimate", "e"), ("moe", "m")):
                text = archive.read(f"{prefix}20175ca{seq}000.txt").decode("latin-1")
                for row in csv.reader(io.StringIO(text)):
                    geoid = logrec.get(row[5])
                    if geoid:
                        values[geoid][kind][table] = row[start:start + cells]
    for geoid, entry in values.items():
        if any(len(entry[k]) != len(ACS_TABLES) for k in ("estimate", "moe")):
            raise SourceError(f"ACS values incomplete for {geoid}")
    subset = {"acs_release": "ACS 2013-2017 5-year summary file", "geography": "block group (summary level 150)",
              "base_url": ACS_BASE, "tables": {t: {"sequence": s, "start_index0": i, "cells": c}
                                              for t, (s, i, c) in ACS_TABLES.items()},
              "extraction": "rows for LA (037) and Ventura (111) block groups whose TIGER 2017 polygon bbox intersects the package bbox; cell values copied verbatim as strings",
              "block_groups": {g: values[g] for g in sorted(values)}}
    geo = fc(features, crs_note=f"TIGER/Line 2017 NAD83 geographic (prj: {prj.strip()}); not transformed to WGS84 (difference ~1-2 m)")
    return encoded_json(subset), encoded_json(geo), {"block_group_count": len(features)}


def acs_int(cells: list[str], index: int) -> int | None:
    value = cells[index]
    return int(value) if re.fullmatch(r"-?\d+", value) else None


def normalize_population(acs_raw: bytes, tiger_raw: bytes) -> dict:
    acs = load_json(acs_raw, "ACS subset")["block_groups"]
    tiger = load_json(tiger_raw, "TIGER subset")
    features = []
    for feature in tiger["features"]:
        geoid = feature["id"]
        est, moe = acs[geoid]["estimate"], acs[geoid]["moe"]
        b25044 = est["B25044"]
        by_vehicles = None
        if all(acs_int(b25044, i) is not None for i in range(15)):
            by_vehicles = {label: acs_int(b25044, owner) + acs_int(b25044, owner + 7)
                           for label, owner in zip(("0", "1", "2", "3", "4", "5_plus"), range(2, 8))}
        age = est["B01001"]
        pop65 = None
        if all(acs_int(age, i) is not None for i in list(range(19, 25)) + list(range(43, 49))):
            pop65 = sum(acs_int(age, i) for i in list(range(19, 25)) + list(range(43, 49)))
        props = {
            "geoid": geoid, "county_fips": feature["properties"]["COUNTYFP"],
            "population": acs_int(est["B01003"], 0), "moe_population": acs_int(moe["B01003"], 0),
            "households": acs_int(est["B11001"], 0), "moe_households": acs_int(moe["B11001"], 0),
            "vehicles_available_total": acs_int(est["B25046"], 0),
            "moe_vehicles_available_total": acs_int(moe["B25046"], 0),
            "occupied_housing_units": acs_int(b25044, 0),
            "households_by_vehicles_available": by_vehicles,
            "households_no_vehicle": by_vehicles["0"] if by_vehicles else None,
            "moe_households_no_vehicle_components": [acs_int(moe["B25044"], 2), acs_int(moe["B25044"], 9)],
            "population_65_plus": pop65,
            "acs_vintage": "2013-2017 5-year", "acs_tables": "B01003, B11001, B25044, B25046, B01001",
            "aland_m2": int(feature["properties"]["ALAND"]), "awater_m2": int(feature["properties"]["AWATER"]),
            "geometry_source": "TIGER/Line 2017 block groups", "evidence_class": "observed",
            "derived_fields": "households_by_vehicles_available = owner + renter cells; population_65_plus = sum of B01001 male/female 65+ cells",
            "source_id": "census-acs-2017-5yr / census-tiger-2017-bg",
        }
        for key in ("population", "households", "vehicles_available_total", "population_65_plus"):
            if props[key] is None:
                props[f"{key}_status"] = "unknown"
        features.append({"type": "Feature", "id": geoid, "geometry": feature["geometry"], "properties": props})
    return fc(features)


def dins_targets(raw: bytes) -> list[dict]:
    source = load_json(raw, "DINS statistics")
    if not isinstance(source, dict) or source.get("error") or not source.get("features"):
        raise SourceError("DINS statistics response is unusable")
    counts: collections.Counter[str] = collections.Counter()
    for feature in source["features"]:
        attrs = feature["attributes"]
        counts[attrs["DAMAGE"]] += attrs["n"]
    locator = ("DINS FeatureServer/0 query where INCIDENTNAME = 'Woolsey', count(OBJECTID) grouped by DAMAGE, COUNTY; "
               "raw/dins-woolsey-damage-stats.json")
    damaged = sum(n for label, n in counts.items() if label.split(" ")[0] in ("Affected", "Minor", "Major"))
    return [
        {"target_id": "woolsey-cal-dins-destroyed", "metric": "structures_destroyed_dins", "value": counts["Destroyed (>50%)"],
         "value_qualifier": "count_of_records", "unit": "structures", "location": "Woolsey DINS records, both counties",
         "source_id": "calfire-dins", "source_locator": locator, "evidence_class": "observed"},
        {"target_id": "woolsey-cal-dins-damaged", "metric": "structures_damaged_dins", "value": damaged,
         "value_qualifier": "count_of_records (Affected + Minor + Major)", "unit": "structures",
         "location": "Woolsey DINS records, both counties", "source_id": "calfire-dins", "source_locator": locator,
         "evidence_class": "derived", "by_category": dict(sorted(counts.items()))},
    ]


# ---------------------------------------------------------------- package

def input_files(inputs: Path) -> dict[str, bytes]:
    files = {}
    for path in sorted(inputs.rglob("*")):
        if path.is_file():
            rel = path.relative_to(inputs).as_posix()
            if rel.startswith("raw/osm-roads-tile") and rel.endswith(".json"):
                # Raw Overpass bytes are kept exactly, gzip-wrapped (mtime 0) to fit the package budget.
                files[rel + ".gz"] = gzip.compress(path.read_bytes(), compresslevel=9, mtime=0)
            elif rel.startswith("raw/"):
                files[rel] = path.read_bytes()
    for rel, path in CURATED.items():
        files[rel] = path.read_bytes()
    return files


def package_files(inputs: dict[str, bytes]) -> dict[str, bytes]:
    tile_paths = [f"raw/osm-roads-tile{i}.json.gz" for i in range(1, len(TILES) + 1)]
    required = tile_paths + ["raw/osm-shelter-features.json", "raw/feds-F17192.json", "raw/acquisition.json",
                             "raw/dins-woolsey-damage-stats.json",
                             "raw/acs2017-5yr-bg-subset.json", "raw/tiger2017-bg-subset.geojson",
                             *[path for _, path in FIRMS_FILES.values()], *CURATED]
    missing = [path for path in required if path not in inputs]
    if missing:
        raise SourceError(f"missing package inputs: {missing}")
    extra = set(inputs) - set(required)
    if extra:
        raise SourceError(f"unexpected package inputs: {sorted(extra)}")
    citygate, bulletins, shelters_table, facts = (load_json(inputs[p], p) for p in CURATED)
    acquisition = load_json(inputs["raw/acquisition.json"], "acquisition log")
    tiles = []
    for path in tile_paths:
        data = gzip.decompress(inputs[path])
        logged = acquisition.get(Path(path).name[:-3], {})
        if sha256(data) != logged.get("sha256") or len(data) != logged.get("bytes"):
            raise SourceError(f"{path}: decompressed bytes differ from the acquisition log")
        tiles.append(data)
    nodes, edges, exits, road_quality = normalize_roads(tiles)
    shelters = normalize_shelters(shelters_table, inputs["raw/osm-shelter-features.json"])
    events = normalize_events(citygate, bulletins, facts, shelters)
    perimeters = normalize_feds(inputs["raw/feds-F17192.json"])
    detections = []
    for product, (_, path) in sorted(FIRMS_FILES.items()):
        detections += normalize_firms(inputs[path], product)
    detections.sort(key=lambda f: (f["properties"]["acquired_at"], f["properties"]["product"],
                                   f["geometry"]["coordinates"]))
    for index, feature in enumerate(detections):
        feature["id"] = f"firms-{index:05d}"
        feature["properties"]["detection_id"] = feature["id"]
    population = normalize_population(inputs["raw/acs2017-5yr-bg-subset.json"], inputs["raw/tiger2017-bg-subset.geojson"])
    calibration = {"targets": facts["calibration_targets"] + dins_targets(inputs["raw/dins-woolsey-damage-stats.json"]),
                   "interpretation": facts["interpretation"]}
    incident = facts["incident"]
    files = dict(inputs)
    normalized = {
        "normalized/road_nodes.geojson": (nodes, len(nodes["features"])),
        "normalized/road_edges.geojson": (edges, len(edges["features"])),
        "normalized/exit_nodes.json": (exits, len(exits["exits"])),
        "normalized/shelters.geojson": (shelters, len(shelters["features"])),
        "normalized/calibration_targets.json": (calibration, len(calibration["targets"])),
        "normalized/fire_perimeters_feds.geojson": (perimeters, len(perimeters["features"])),
        "normalized/fire_detections.geojson": (fc(detections), len(detections)),
        "normalized/population_units.geojson": (population, len(population["features"])),
        "normalized/incident.json": (incident, None),
    }
    for path, (value, _) in normalized.items():
        files[path] = encoded_json(value)
    files["normalized/events.jsonl"] = b"".join(encoded_json(e) for e in events)
    counts = {path: count for path, (_, count) in normalized.items()} | {"normalized/events.jsonl": len(events)}
    type_counts = collections.Counter(e["type"] for e in events)
    pops = [f["properties"]["population"] for f in population["features"] if f["properties"]["population"] is not None]
    quality = {
        "roads": road_quality,
        "events": {"count": len(events), "by_type": dict(sorted(type_counts.items())),
                   "time_coverage_utc": [events[0]["occurred_at"], events[-1]["occurred_at"]],
                   "with_geometry": sum(1 for e in events if e["geometry"]),
                   "osm_way_matches": 0},
        "shelters": {"count": len(shelters["features"]),
                     "located": sum(1 for f in shelters["features"] if f["geometry"]),
                     "inside_bbox": sum(1 for f in shelters["features"] if f["properties"]["in_package_bbox"])},
        "population": {"block_groups": len(population["features"]), "population_sum": sum(pops),
                       "selection": "bbox-intersecting block groups; sums exceed the evacuated population"},
        "fire_perimeters": {"count": len(perimeters["features"]),
                            "first_snapshot_at": perimeters["features"][0]["properties"]["snapshot_at"],
                            "last_snapshot_at": perimeters["features"][-1]["properties"]["snapshot_at"]},
        "fire_detections": {"count": len(detections),
                            "by_product": dict(collections.Counter(f["properties"]["product"] for f in detections)),
                            "time_coverage_utc": [detections[0]["properties"]["acquired_at"],
                                                  detections[-1]["properties"]["acquired_at"]]},
    }
    files["quality.json"] = encoded_json(quality)
    files["sources.json"] = encoded_json({"acquisition_log": acquisition, "curated_table_sources": {
        "citygate-aar-2019": facts["sources"]["citygate-aar-2019"],
        **facts["sources"], "shelters": shelters_table["sources"],
        "lacofd-bulletins": bulletins["bulletins"]}})
    version = sha256(b"".join(path.encode() + b"\0" + sha256(data).encode() + b"\n"
                              for path, data in sorted(inputs.items())) + NORMALIZER_VERSION.encode())[:16]
    layers = layer_status(events, shelters, population, perimeters, detections, calibration, nodes, edges)
    manifest = {
        "schema_version": "0.1.0", "normalizer_version": NORMALIZER_VERSION, "incident_id": INCIDENT_ID,
        "incident_numbers": [n["value"] for n in incident["incident_numbers"]],
        "package_version": version, "requested_bbox": list(BBOX), "actual_road_bbox": road_quality["actual_bbox"],
        "coordinate_reference_system": "OGC:CRS84", "coordinate_order": "longitude, latitude",
        "time_zone": "America/Los_Angeles (PST, UTC-08:00 throughout the incident)",
        "focus_window_utc": ["2018-11-08T22:00:00Z", "2018-11-10T08:00:00Z"],
        "ignition": {"first_report_utc": "2018-11-08T22:24:00Z", "first_report_local": incident["first_report_local"],
                     "time_precision": "minute", "note": "ignition at or shortly before the first report; utility lockout at 22:22Z"},
        "layers": layers,
        "artifacts": [artifact(path, data, counts.get(path)) for path, data in sorted(files.items())],
    }
    files["manifest.json"] = encoded_json(manifest)
    return files


def layer_status(events, shelters, population, perimeters, detections, calibration, nodes, edges) -> dict:
    layers = {name: {"status": "missing", "reason": "not acquired"} for name in LAYER_NAMES}
    layers["roads"] = {"status": "present", "snapshot_at": SNAPSHOT_AT, "node_count": len(nodes["features"]),
                       "directed_edge_count": len(edges["features"]),
                       "coverage": "OSM attic snapshot in ten Overpass tiles; mapped completeness not verified"}
    layers["events"] = {"status": "partial", "count": len(events),
                        "coverage": "Citygate AAR timeline (LA County focus), two unified-command bulletins, CPUC lockout",
                        "missing": "Ventura County order/alert log for Nov 8-9 (VC Alert, Nixle), CHP/Caltrans closure onset and reopening log, OSM edge matches"}
    layers["evacuation_zones"] = {"status": "missing",
                                  "reason": "No 2018 polygons found. LA County Fire's three ad-hoc planning zones (Citygate p. 34) and Topanga zones 1-9 exist only as text/labels; orders are described by street boundaries and kept as place_name text."}
    layers["population_units"] = {"status": "present", "count": len(population["features"]),
                                  "vintage": "ACS 2013-2017 5-year (released Dec 2018, after the fire; latest vintage ending before 2018)",
                                  "zone_population_crosswalk": "missing: no zone polygons"}
    layers["traffic_observations"] = {"status": "access_blocked",
                                      "reason": "Caltrans PeMS District 7 requires an account (no credentials). No public PeMS mirror or published US-101/PCH counts for Nov 8-10, 2018 were found; Citygate Finding 47 gives only a qualitative PCH congestion statement."}
    layers["calibration_targets"] = {"status": "partial", "count": len(calibration["targets"]),
                                     "missing": "vehicle flows, clearance times, departure-time distributions (no Woolsey-specific survey found)"}
    layers["shelters"] = {"status": "present", "count": len(shelters["features"]),
                          "gaps": "capacities unpublished; opening times known only for Taft, Pierce, Hansen Dam, Pepperdine"}
    layers["fire_progression_reconstructed"] = {"status": "missing",
                                                "reason": "No expert isochrone reconstruction (NIST-style) found for Woolsey. Use timed fire_arrival / fire_status_report events and FIRMS detections; first FEDS perimeter is 2018-11-09T08:00Z."}
    layers["fire_perimeters"] = {"status": "present", "count": len(perimeters["features"]), "source": "NASA VEDA FEDS F17192"}
    layers["fire_detections"] = {"status": "present", "count": len(detections), "source": "NASA FIRMS MODIS C6.1 and VIIRS S-NPP 375 m archive"}
    layers["displacement"] = {"status": "missing", "reason": "lower priority; not acquired"}
    layers["terrain_grid"] = {"status": "missing", "reason": "not acquired in this pass (USGS 3DEP)"}
    layers["buildings"] = {"status": "missing", "reason": "not acquired in this pass"}
    layers["street_imagery"] = {"status": "missing", "reason": "Mapillary token unavailable; KartaView not queried in this pass"}
    layers["media_evidence"] = {"status": "missing", "reason": "not acquired in this pass"}
    return layers


def write_package(files: dict[str, bytes], output_root: Path) -> Path:
    version = load_json(files["manifest.json"], "manifest")["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="woolsey-", dir=target.parent) as temp_dir:
        temporary = Path(temp_dir) / "pkg"
        for name, data in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        shutil.move(str(temporary), str(target))
    return target


def verify(package: Path) -> dict:
    manifest = load_json((package / "manifest.json").read_bytes(), "manifest")
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("package identity or normalizer version mismatch")
    listed = {item["path"] for item in manifest["artifacts"]}
    for item in manifest["artifacts"]:
        data = (package / item["path"]).read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
    on_disk = {p.relative_to(package).as_posix() for p in package.rglob("*") if p.is_file()}
    if on_disk != listed | {"manifest.json"}:
        raise SourceError(f"package files differ from manifest: {sorted(on_disk ^ (listed | {'manifest.json'}))}")
    inputs = {path: (package / path).read_bytes() for path in listed
              if path.startswith("raw/") or path.startswith("curated/")}
    rebuilt = package_files(inputs)
    if set(rebuilt) != on_disk:
        raise SourceError("rebuilt artifact list differs")
    for name, data in rebuilt.items():
        if (package / name).read_bytes() != data:
            raise SourceError(f"offline normalization mismatch: {name}")
    if package.name != manifest["package_version"]:
        raise SourceError("package directory and version differ")
    quality = load_json((package / "quality.json").read_bytes(), "quality")
    return {"package_version": manifest["package_version"],
            "layers": {k: v["status"] for k, v in manifest["layers"].items()},
            "roads": {k: quality["roads"][k] for k in ("node_count", "directed_edge_count",
                                                      "largest_strongly_connected_component_nodes", "exit_node_count")},
            "events": quality["events"]["count"], "shelters": quality["shelters"],
            "population_block_groups": quality["population"]["block_groups"],
            "fire_perimeters": quality["fire_perimeters"]["count"],
            "fire_detections": quality["fire_detections"]["count"]}


# ---------------------------------------------------------------- CLI

def log_acquisition(inputs: Path, key: str, entry: dict) -> None:
    path = inputs / "raw/acquisition.json"
    log = json.loads(path.read_bytes()) if path.exists() else {}
    log[key] = entry
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded_json(log))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", choices=["fetch-osm", "fetch-shelters", "fetch-feds",
                                                       "extract-firms", "extract-acs", "build"])
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--modis", type=Path)
    parser.add_argument("--viirs", type=Path)
    parser.add_argument("--acs-dir", type=Path)
    parser.add_argument("--tiger", type=Path)
    parser.add_argument("--overpass-url", default=OVERPASS_URL, choices=OVERPASS_MIRRORS)
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
        return
    if not args.command or not args.inputs:
        parser.error("a command and --inputs are required")
    raw_dir = args.inputs / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "fetch-osm":
        for index, tile in enumerate(TILES, 1):
            path = raw_dir / f"osm-roads-tile{index}.json"
            if path.exists():
                continue
            query = road_tile_query(tile)
            data = overpass(query, args.overpass_url)
            path.write_bytes(data)
            log_acquisition(args.inputs, path.name, {"url": args.overpass_url, "query": query, "acquired_at": now_text(),
                                                     "bytes": len(data), "sha256": sha256(data), "license": "ODbL 1.0",
                                                     "attribution": "© OpenStreetMap contributors"})
    elif args.command == "fetch-shelters":
        query = shelter_query(json.loads(CURATED["curated/shelters.json"].read_bytes()))
        data = overpass(query, args.overpass_url)
        (raw_dir / "osm-shelter-features.json").write_bytes(data)
        log_acquisition(args.inputs, "osm-shelter-features.json", {"url": args.overpass_url, "user_agent": USER_AGENT, "query": query,
                        "acquired_at": now_text(), "bytes": len(data), "sha256": sha256(data), "license": "ODbL 1.0"})
    elif args.command == "fetch-feds":
        data = curl(["--get", "--data-urlencode", f"filter=fireid = '{FEDS_FIRE_ID}'", "--data-urlencode",
                     f"datetime={FEDS_DATETIME}", "--data-urlencode", "limit=100", FEDS_URL], 180)
        (raw_dir / "feds-F17192.json").write_bytes(data)
        log_acquisition(args.inputs, "feds-F17192.json", {"url": FEDS_URL, "params": {"filter": f"fireid = '{FEDS_FIRE_ID}'",
                        "datetime": FEDS_DATETIME, "limit": 100}, "acquired_at": now_text(), "bytes": len(data),
                        "sha256": sha256(data), "license": "unknown (VEDA API states none; see Camp package notes)",
                        "fire_id_discovery": "bbox+datetime query on 2018-11-08/12 returned F17192 (~400 km2, Woolsey) and F17197 (~5.6 km2, Hill Fire, excluded)"})
    elif args.command == "extract-firms":
        for product, source in (("modis", args.modis), ("viirs-snpp", args.viirs)):
            full = source.read_bytes()
            subset = extract_firms(full)
            url, rel = FIRMS_FILES[product]
            (args.inputs / rel).write_bytes(subset)
            log_acquisition(args.inputs, Path(rel).name, {
                "url": url, "full_file_bytes": len(full), "full_file_sha256": sha256(full),
                "subset_bytes": len(subset), "subset_sha256": sha256(subset), "evidence_class": "derived",
                "extraction": f"rows with longitude/latitude inside {list(BBOX)} and acq_date {FIRMS_DATES[0]}..{FIRMS_DATES[1]} (UTC), original CSV lines kept",
                "license": "NASA FIRMS open data; cite LANCE/FIRMS (https://www.earthdata.nasa.gov/data/tools/firms)"})
    elif args.command == "extract-acs":
        acs, tiger, info = extract_acs(args.acs_dir, args.tiger)
        (raw_dir / "acs2017-5yr-bg-subset.json").write_bytes(acs)
        (raw_dir / "tiger2017-bg-subset.geojson").write_bytes(tiger)
        full = {name: {"url": ACS_BASE + name, "bytes": (args.acs_dir / name).stat().st_size,
                       "sha256": sha256((args.acs_dir / name).read_bytes())}
                for name in ["g20175ca.csv"] + sorted({f"20175ca{s}000.zip" for s, _, _ in ACS_TABLES.values()})}
        tiger_bytes = args.tiger.read_bytes()
        log_acquisition(args.inputs, "acs2017-5yr-bg-subset.json", {"full_files": full, **info,
                        "subset_sha256": sha256(acs), "evidence_class": "derived", "license": "US Census Bureau, public domain"})
        log_acquisition(args.inputs, "tiger2017-bg-subset.geojson", {"full_file": {"url": TIGER_URL, "bytes": len(tiger_bytes),
                        "sha256": sha256(tiger_bytes)}, **info, "subset_sha256": sha256(tiger), "evidence_class": "derived",
                        "extraction": "stdlib .shp/.dbf reader; LA and Ventura block groups whose bbox intersects the package bbox",
                        "license": "US Census Bureau TIGER/Line, public domain"})
    elif args.command == "build":
        print(write_package(package_files(input_files(args.inputs)), args.output_root))


if __name__ == "__main__":
    main()
