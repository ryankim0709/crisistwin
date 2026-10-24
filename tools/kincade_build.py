"""Build or verify the immutable Kincade Fire (2019) evacuation package.

Usage (from the repository root):

    python3.12 -m tools.kincade_build fetch --sources DIR      # network: curl, fixed endpoints
    python3.12 -m tools.kincade_build build --sources DIR      # offline: DIR -> data/incidents/...
    python3.12 -m tools.kincade_build --verify-package PATH    # offline rebuild + byte compare

``DIR`` holds the exact downloads under the names in ``SOURCE_FILES``. Bulky
federal sources (TIGER, ACS, FIRMS) are reduced to deterministic subsets at
build time; their full-file sizes and SHA-256 are recorded in sources.json.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path

from tools.kincade_common import (
    BBOX, INCIDENT_ID, INCIDENT_NUMBER, SNAPSHOT_AT, SourceError, encoded_json, file_digest, gunzip_checked,
    gzip_bytes, load_json, local_to_utc, sha256, utc_text,
)
from tools import kincade_events, kincade_fire, kincade_population, kincade_roads, kincade_traffic, kincade_zones

NORMALIZER_VERSION = "kincade-1"
SCHEMA_VERSION = "0.1.0"
TOOLS = Path(__file__).parent
CURATED = {
    "curated/kincade_events_table.json": TOOLS / "kincade_events_table.json",
    "curated/kincade_traffic_stations.json": TOOLS / "kincade_traffic_stations.json",
    "curated/kincade_shelters_table.json": TOOLS / "kincade_shelters_table.json",
    "curated/kincade_calibration_table.json": TOOLS / "kincade_calibration_table.json",
}
ZONE_SERVICE = kincade_zones.SERVICE_ROOT
SUBSET_METHODS = {
    "derived/zenodo-sheet1-cells.csv": "Sheet1 of data_routine_evacuation.xlsx, columns A-D, G, M, S, W-AB (time, detector, scenario, health, per-lane flows, per-lane-average block) for every row; shared strings as s:<text>, numbers as the exact XML <v> text",
    "derived/tiger2018-bg-subset.geojson": "TIGER 2018 CA block groups whose shapefile bbox overlaps BBOX; rings re-oriented to RFC 7946",
    "derived/tiger2018-place-subset.geojson": "TIGER 2018 CA place polygons whose NAME is in PLACE_NAMES (Geyserville CDP); rings re-oriented to RFC 7946",
    "derived/acs2018-bg-subset.json": "ACS estimate/MOE cells of the listed tables for the TIGER subset GEOIDs (LOGRECNO join via g20185ca.txt)",
    "derived/firms-modis-subset.csv": "rows of the full CSV with longitude/latitude in BBOX and acq_date 2019-10-23..2019-11-07, header kept",
    "derived/firms-viirs-snpp-subset.csv": "rows of the full CSV with longitude/latitude in BBOX and acq_date 2019-10-23..2019-11-07, header kept",
}
# Source-directory file name -> package raw path. "gz" sources are stored gzip-wrapped.
RAW_SOURCES = {
    **{f"osm/tile{i}.json": (f"raw/osm/tile{i}.json.gz", "gz") for i in range(1, len(kincade_roads.TILES) + 1)},
    **{f"zones/feat_{n}.geojson": (f"raw/sonoma-eoc-zones/{n}.geojson.gz", "gz") for n in kincade_zones.LAYER_NAMES},
    "misc/calfire-2019.json": ("raw/calfire-incidents-2019.json.gz", "gz"),
    "feds/feds-F15031.json": ("raw/feds-F15031.json.gz", "gz"),
    "dins/dins-kincade.json": ("raw/calfire-dins-kincade.json.gz", "gz"),
    "misc/pm101.json": ("raw/caltrans-shn-postmiles-us101.json.gz", "gz"),
}
# Bulky sources: recorded by digest, packaged only as derived subsets.
BULK_SOURCES = (
    "zenodo/data_routine_evacuation.xlsx", "tiger/tl_2018_06_bg.zip", "tiger/tl_2018_06_place.zip", "acs/g20185ca.txt",
    *(f"acs/20185ca{s}000.zip" for s in sorted({v[0] for v in kincade_population.TABLES.values()})),
    "firms/modis_2019_United_States.csv", "firms/viirs-snpp_2019_United_States.csv",
)
# Documents read for curated tables; recorded by digest only (not redistributed).
REFERENCE_DOCS = (
    "socoemergency/matrix.pdf", "aar/aar.pdf", "papers/trd.pdf", "misc/nhc-qr326.html",
    "misc/nbc-evac-centers.html", "zenodo/data_routine_weeks.xlsx", "zenodo/record.json",
)
SOURCES = {
    "osm-overpass-2019-10-23": {
        "provider": "OpenStreetMap contributors via Overpass attic query", "url": kincade_roads.OVERPASS_URL,
        "queries": [kincade_roads.overpass_query(t) for t in kincade_roads.TILES], "snapshot_at": SNAPSHOT_AT,
        "license": "ODbL 1.0", "license_url": "https://www.openstreetmap.org/copyright",
        "attribution": "© OpenStreetMap contributors"},
    "zenodo-7410114-kincade-pems": {
        "provider": "Rohaert et al., Dataset of traffic dynamics during the 2019 Kincade Wildfire Evacuation (Caltrans PeMS)",
        "doi": "10.5281/zenodo.7410114", "url": "https://zenodo.org/records/7410114",
        "files": {"data_routine_evacuation.xlsx": {"md5_published": "5c3d5a1adbdae347c81e75a8d4a51851"},
                  "data_routine_weeks.xlsx": {"md5_published": "0ab198778c5eab3416b4ae27f3f783f4",
                                              "packaged": False, "reason": "same routine-weekend rows regrouped by ISO week; not needed to rebuild"}},
        "license": "CC BY 4.0", "attribution": "Rohaert, Kuligowski, Ardinge, Wahlqvist, Gwynne, Kimball, Bénichou, Ronchi (2022); data from Caltrans PeMS"},
    "rohaert-2023-trd-103610": {
        "provider": "Rohaert et al. (2023) Traffic dynamics during the 2019 Kincade wildfire evacuation, Transportation Research Part D 116:103610",
        "doi": "10.1016/j.trd.2023.103610", "url": "https://nrc-publications.canada.ca/eng/view/ft/?id=553e2166-96a0-4a8f-98d6-dee7d31b0757",
        "license": "CC BY-NC-ND 4.0 (article; only facts transcribed)", "packaged": False},
    "sonoma-calfire-evac-order-matrix": {
        "provider": "County of Sonoma / CAL FIRE, Kincade Fire Evacuation Orders matrix and maps (PDF, created 2019-11-08)",
        "url": "https://s43263.pcdn.co/wp-content/uploads/2019/11/Sonoma-County-2019-Kincade-Fire-CalFIRE-Evacuation-Order-Matrix-and-Maps.pdf",
        "landing_page": "https://socoemergency.org/recover/2019-kincade-fire/kincade-fire-evacuation-orders/",
        "license": "public government record; no license stated", "packaged": False,
        "reason": "16.5 MB PDF of maps; rows transcribed to curated/kincade_events_table.json"},
    "sonoma-eoc-arcgis-kincade-zones": {
        "provider": "County of Sonoma EOC GIS (ArcGIS Online user eocgisfc, org P5Mv5GY5S66M8Z1Q)",
        "url": ZONE_SERVICE, "query": "FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&f=geojson",
        "license": "public ArcGIS items; licenseInfo empty (no license stated)",
        "attribution": "County of Sonoma Department of Emergency Management; zones issued by CAL FIRE"},
    "calfire-incident-api-2019": {
        "provider": "CAL FIRE incident list API", "url": kincade_events.CALFIRE_URL,
        "license": "public government data; no license stated", "attribution": "CAL FIRE"},
    "sonoma-kincade-aar-2020": {
        "provider": "County of Sonoma, 2019 Kincade Fire After-Action Report and Improvement Plan (March 2020)",
        "url": "https://sonomacounty.gov/Main%20County%20Site/Administrative%20Support%20&%20Fiscal%20Services/Emergency%20Management/Documents/Archive/Administration/Services/Training__3/Service%201/_Documents/Sonoma-County-2019-Kincade-Fire-AAR-FINAL-ADA.pdf",
        "license": "public government report; no license stated", "packaged": False},
    "nhc-qr326-zhao-2021": {
        "provider": "Zhao et al. (2021) Modeling Evacuation Behavior in the 2019 Kincade Fire, Natural Hazards Center Quick Response Report 326",
        "url": "https://hazards.colorado.edu/quick-response-report/modeling-evacuation-behavior-in-the-2019-kincade-fire-sonoma-county-california",
        "license": "all rights reserved (facts transcribed)", "packaged": False},
    "nbcbayarea-kincade-evac-centers": {
        "provider": "NBC Bay Area, Kincade Fire Evacuation Centers (published 2019-10-26, modified 2019-11-02)",
        "url": "https://www.nbcbayarea.com/news/local/Kincade-Fire-Evacuation-Centers-563926721.html",
        "license": "all rights reserved (facility names/addresses transcribed)", "packaged": False},
    "nominatim-geocoder": {
        "provider": "OpenStreetMap Nominatim (current data)", "url": "https://nominatim.openstreetmap.org/search",
        "license": "ODbL 1.0", "attribution": "© OpenStreetMap contributors"},
    "feds-veda-archive": {
        "provider": "NASA VEDA FEDS large-fire perimeter archive", "url": kincade_fire.FEDS_URL,
        "query": kincade_fire.FEDS_QUERY,
        "license": "not stated on the VEDA collection endpoint (see Camp package notes)"},
    "nasa-firms-modis-2019": {
        "provider": "NASA FIRMS MODIS C6.1 yearly country archive", "url": f"{kincade_fire.FIRMS_BASE}/{kincade_fire.FIRMS_FILES['modis']}",
        "license": "NASA open data; cite FIRMS", "subset": "bbox + acq_date 2019-10-23..2019-11-07"},
    "nasa-firms-viirs-snpp-2019": {
        "provider": "NASA FIRMS VIIRS S-NPP 375 m yearly country archive", "url": f"{kincade_fire.FIRMS_BASE}/{kincade_fire.FIRMS_FILES['viirs-snpp']}",
        "license": "NASA open data; cite FIRMS", "subset": "bbox + acq_date 2019-10-23..2019-11-07"},
    "caltrans-shn-postmiles": {
        "provider": "Caltrans GIS, SHN Postmiles Tenth (current service)", "url": kincade_traffic.POSTMILE_URL,
        "query": kincade_traffic.POSTMILE_QUERY, "license": "public government data; no license stated",
        "use": "US 101 Odometer -> point lookup for detector locations (derived)"},
    "calfire-dins": {
        "provider": "CAL FIRE Damage Inspection (DINS)", "url": kincade_fire.DINS_URL,
        "query": {"where": f"INCIDENTNAME='Kincade' AND INCIDENTNUM='{INCIDENT_NUMBER}'", "outFields": ",".join(kincade_fire.DINS_FIELDS), "outSR": "4326"},
        "license": "public government data; no license stated"},
    "census-acs-2018-5yr-bg": {
        "provider": "US Census Bureau ACS 2014-2018 5-year summary file (California, tracts and block groups)",
        "url": kincade_population.ACS_BASE, "tables": sorted(kincade_population.TABLES),
        "license": "public domain (US federal)"},
    "census-tiger-2018-bg": {
        "provider": "US Census Bureau TIGER/Line 2018 block groups (California)", "url": kincade_population.TIGER_URL,
        "license": "public domain (US federal)"},
    "census-tiger-2018-place": {
        "provider": "US Census Bureau TIGER/Line 2018 places (California)", "url": kincade_population.PLACE_URL,
        "license": "public domain (US federal)"},
    "designsafe-ds2-9v8w-y830": {
        "provider": "Xu et al. (2022) highway vehicle routing dataset, DesignSafe-CI", "doi": "10.17603/ds2-9v8w-y830",
        "descriptor": "https://doi.org/10.1038/s41597-022-01731-6 (Sci Data 9:608, CC BY 4.0)",
        "landing_page": "https://www.designsafe-ci.org/data/browser/public/designsafe.storage.published/PRJ-3226",
        "license": "not stated in DataCite metadata (rightsList empty); DesignSafe page not checked",
        "packaged": False,
        "reason": ("21,160 per-device proxy highway entrance/exit records (Gravy Analytics GPS) with anonymous device IDs "
                   "and timestamps: individual-level traces, excluded by the privacy rule. They are derived proxies, not "
                   "observed traffic counts. Aggregates could be computed in future after a privacy review.")},
}


def read_sources(directory: Path) -> dict[str, bytes]:
    names = list(RAW_SOURCES) + list(BULK_SOURCES) + ["acquisition.json"]
    missing = [n for n in names if not (directory / n).is_file()]
    if missing:
        raise SourceError(f"source directory lacks: {missing}")
    return {n: (directory / n).read_bytes() for n in names}


def assemble(raw: dict[str, bytes], derived: dict[str, bytes], curated: dict[str, bytes],
             acquisition: dict, digests: dict) -> dict[str, bytes]:
    """Normalize every layer from original raw bytes, subsets and curated tables."""
    tiles = [raw[f"osm/tile{i}.json"] for i in range(1, len(kincade_roads.TILES) + 1)]
    nodes, edges, exits, road_q = kincade_roads.normalize_roads(tiles)
    zones, zone_q = kincade_zones.normalize_zones(
        {n: raw[f"zones/feat_{n}.geojson"] for n in kincade_zones.LAYER_NAMES}, derived["derived/tiger2018-place-subset.geojson"])
    zone_ids = {f["id"] for f in zones["features"]}
    events = kincade_events.normalize_events(curated["curated/kincade_events_table.json"],
                                             raw["misc/calfire-2019.json"], zone_ids)
    station_table = curated["curated/kincade_traffic_stations.json"]
    stations = kincade_traffic.stations(station_table, raw["misc/pm101.json"])
    observations, traffic_q = kincade_traffic.normalize_traffic(derived["derived/zenodo-sheet1-cells.csv"], station_table)
    population, pop_q = kincade_population.normalize_population(
        derived["derived/tiger2018-bg-subset.geojson"], derived["derived/acs2018-bg-subset.json"])
    crosswalk = kincade_population.zone_crosswalk(population, zones)
    feds, feds_q = kincade_fire.normalize_feds(raw["feds/feds-F15031.json"])
    firms, firms_q = kincade_fire.normalize_firms({
        "modis": derived["derived/firms-modis-subset.csv"], "viirs-snpp": derived["derived/firms-viirs-snpp-subset.csv"]})
    dins, dins_q = kincade_fire.normalize_dins(raw["dins/dins-kincade.json"])
    shelters = normalize_shelters(curated["curated/kincade_shelters_table.json"])
    calibration = normalize_calibration(curated["curated/kincade_calibration_table.json"])

    files: dict[str, bytes] = {}
    for name, data in raw.items():
        if name in RAW_SOURCES:
            path, mode = RAW_SOURCES[name]
            files[path] = gzip_bytes(data) if mode == "gz" else data
    for name, data in derived.items():
        files[name + ".gz"] = gzip_bytes(data)
    files.update(curated)
    files["raw/acquisition.json"] = encoded_json(acquisition)
    normalized = {
        "normalized/road_nodes.geojson": encoded_json(nodes),
        "normalized/road_edges.geojson": encoded_json(edges),
        "normalized/exit_nodes.json": encoded_json(exits),
        "normalized/events.jsonl": b"".join(encoded_json(e) for e in events),
        "normalized/evacuation_zones.geojson": encoded_json(zones),
        "normalized/population_units.geojson": encoded_json(population),
        "normalized/zone_population_crosswalk.json": encoded_json(crosswalk),
        "normalized/traffic_stations.geojson": encoded_json(stations),
        "normalized/traffic_observations.jsonl.gz": gzip_bytes(b"".join(encoded_json(o) for o in observations)),
        "normalized/calibration_targets.json": encoded_json(calibration),
        "normalized/shelters.geojson": encoded_json(shelters),
        "normalized/fire_perimeters.geojson": encoded_json(feds),
        "normalized/fire_detections.geojson": encoded_json(firms),
        "normalized/damage_assessments.geojson": encoded_json(dins),
    }
    files.update(normalized)
    counts = {
        "normalized/road_nodes.geojson": len(nodes["features"]), "normalized/road_edges.geojson": len(edges["features"]),
        "normalized/exit_nodes.json": len(exits["exits"]), "normalized/events.jsonl": len(events),
        "normalized/evacuation_zones.geojson": len(zones["features"]),
        "normalized/population_units.geojson": len(population["features"]),
        "normalized/zone_population_crosswalk.json": len(crosswalk["rows"]),
        "normalized/traffic_stations.geojson": len(stations["features"]),
        "normalized/traffic_observations.jsonl.gz": len(observations),
        "normalized/calibration_targets.json": len(calibration["targets"]),
        "normalized/shelters.geojson": len(shelters["features"]),
        "normalized/fire_perimeters.geojson": len(feds["features"]),
        "normalized/fire_detections.geojson": len(firms["features"]),
        "normalized/damage_assessments.geojson": len(dins["features"]),
    }
    quality = {"roads": road_q, "evacuation_zones": zone_q, "traffic": traffic_q, "population": pop_q,
               "fire_perimeters": feds_q, "fire_detections": firms_q, "damage_assessments": dins_q,
               "events": {"count": len(events), "by_type": _count(e["type"] for e in events),
                          "time_coverage_utc": [events[0]["occurred_at"], events[-1]["occurred_at"]]}}
    files["quality.json"] = encoded_json(quality)
    sources = json.loads(json.dumps(SOURCES))
    for sid, entry in sources.items():
        entry["accessed_at"] = acquisition.get(sid)
    sources["_files"] = digests
    files["sources.json"] = encoded_json(sources)
    manifest = build_manifest(files, counts, events, observations, quality)
    files["manifest.json"] = encoded_json(manifest)
    return files


def _count(items) -> dict:
    out: dict[str, int] = {}
    for item in items:
        out[item] = out.get(item, 0) + 1
    return dict(sorted(out.items()))


def normalize_shelters(table_bytes: bytes) -> dict:
    table = load_json(table_bytes, "shelter table")
    features = []
    for row in table["shelters"]:
        features.append({"type": "Feature", "id": f"kincade-shelter:{row['id']}",
                         "geometry": {"type": "Point", "coordinates": row["lon_lat"]},
                         "properties": {
                             "shelter_id": f"kincade-shelter:{row['id']}", "name": row["name"], "kind": row["kind"],
                             "address_public_facility": row["address"],
                             "opened_at": None, "opened_at_status": "unknown",
                             "capacity_persons": None, "capacity_persons_status": "unknown",
                             "occupancy_reports": [],
                             "listed_status": row["listed_status"],
                             "listed_status_as_of": "2019-11-02 (article modification; exact time ambiguous in page metadata)",
                             "listed_status_time_precision": "day",
                             "geocode_method": f"nominatim_current_osm ({row['osm']})", "geocode_precision": row["geocode_precision"],
                             "evidence_class": "reported", "source_id": table["source_id"],
                             "source_locator": f"{table['source_url']} (list heading for this facility)",
                         }})
    return {"type": "FeatureCollection", "features": features,
            "aggregate_occupancy_note": "County-wide sheltered counts (1,168 on 10/26; 3,305 on 10/29; 858 on 10/31) are in events.jsonl and calibration_targets.json; they are not attributed to individual sites."}


def normalize_calibration(table_bytes: bytes) -> dict:
    table = load_json(table_bytes, "calibration table")
    targets = []
    for row in table["targets"]:
        window = row.get("window_local")
        utc = [utc_text(local_to_utc(datetime.fromisoformat(t))) for t in window] if window else None
        targets.append({**row, "window_utc": utc})
    return {"interpretation": table["interpretation"], "targets": targets}


def build_manifest(files: dict[str, bytes], counts: dict, events: list, observations: list, quality: dict) -> dict:
    version = sha256(b"".join(f"{p}\0{sha256(d)}\n".encode() for p, d in sorted(files.items()))
                     + NORMALIZER_VERSION.encode())[:16]
    evac = [o["interval_start"] for o in observations]
    layers = {
        "roads": {"status": "present", "snapshot_at": SNAPSHOT_AT,
                  "node_count": counts["normalized/road_nodes.geojson"],
                  "directed_edge_count": counts["normalized/road_edges.geojson"],
                  "largest_scc_nodes": quality["roads"]["largest_strongly_connected_component_nodes"],
                  "coverage": "pre-fire OSM attic snapshot over the package bbox; service roads not requested"},
        "events": {"status": "partial", "count": len(events),
                   "time_coverage_utc": quality["events"]["time_coverage_utc"],
                   "coverage": "official zone order/warning/open matrix (15 status times), CAL FIRE ignition/containment, US 101 closures, AAR power/shelter timeline",
                   "missing": "individual SoCoAlert/Nixle/WEA message times, local road closures other than US 101, fire-arrival times, facility evacuations"},
        "evacuation_zones": {"status": "present", "count": counts["normalized/evacuation_zones.geojson"],
                             "zone_system_version": "CAL FIRE Kincade incident zones (Oct-Nov 2019) via Sonoma County EOC layers; predates Zonehaven"},
        "population_units": {"status": "present", "count": counts["normalized/population_units.geojson"],
                             "acs_vintage": kincade_population.ACS_VINTAGE,
                             "crosswalk": "normalized/zone_population_crosswalk.json (derived lattice area shares)"},
        "traffic_observations": {"status": "partial", "count": len(observations), "interval_s": 300,
                                 "time_coverage_utc": [min(evac), max(evac)],
                                 "coverage": "24 US 101 dual-loop stations, 8 routine weekend days + 2019-10-26/27 evacuation weekend",
                                 "missing": "station coordinates/VDS IDs, weekdays, Oct 28-29, all other routes (SR 12/116/128/1 have no detectors)",
                                 "format": "gzip-compressed JSONL (size)"},
        "calibration_targets": {"status": "present", "count": counts["normalized/calibration_targets.json"]},
        "shelters": {"status": "partial", "count": counts["normalized/shelters.geojson"],
                     "missing": "opening times, capacities and per-site occupancy; list reflects a 2019-11-02 article update"},
        "fire_progression_reconstructed": {"status": "missing",
                                           "reason": "no NIST-style reconstruction published for Kincade; FEDS half-day perimeters are in fire_perimeters"},
        "fire_perimeters": {"status": "present", "count": counts["normalized/fire_perimeters.geojson"],
                            "path": "normalized/fire_perimeters.geojson",
                            "bbox": quality["fire_perimeters"]["bbox"],
                            "max_gap_hours": quality["fire_perimeters"]["max_gap_hours"],
                            "evidence_class": "derived (satellite)"},
        "fire_detections": {"status": "present", "count": counts["normalized/fire_detections.geojson"]},
        "damage_assessments": {"status": "present", "count": counts["normalized/damage_assessments.geojson"],
                               "path": "normalized/damage_assessments.geojson", "temporal_role": "post_event"},
        "displacement": {"status": "missing", "reason": "not acquired (lower priority)"},
        "terrain_grid": {"status": "missing", "reason": "not acquired"},
        "buildings": {"status": "missing", "reason": "not acquired"},
        "street_imagery": {"status": "missing", "reason": "not acquired"},
        "media_evidence": {"status": "missing", "reason": "not acquired"},
        "highway_routing_proxy": {"status": "blocked", "reason": "DesignSafe ds2-9v8w-y830 records are individual device traces (privacy rule)"},
    }
    return {
        "schema_version": SCHEMA_VERSION, "normalizer_version": NORMALIZER_VERSION,
        "incident_id": INCIDENT_ID, "incident_number": INCIDENT_NUMBER, "incident_name": "Kincade Fire",
        "ignition_utc": "2019-10-24T04:27:00Z", "ignition_local_as_written": "10/23/2019 9:27 PM (CAL FIRE)",
        "package_version": version, "requested_bbox": list(BBOX),
        "coordinate_reference_system": "OGC:CRS84", "coordinate_order": "longitude, latitude",
        "time_zone": "America/Los_Angeles",
        "time_zone_note": "PDT (UTC-7) until 2019-11-03 02:00 local, PST (UTC-8) after; all converted timestamps are UTC with Z",
        "focus_window_utc": ["2019-10-23T12:00:00Z", "2019-10-29T12:00:00Z"],
        "layers": layers,
        "artifacts": [dict(path=p, **file_digest(d), **({"count": counts[p]} if p in counts else {}))
                      for p, d in sorted(files.items())],
    }


def derive_subsets(bulk: dict[str, bytes]) -> dict[str, bytes]:
    seqs = {s: bulk[f"acs/20185ca{s}000.zip"] for s in sorted({v[0] for v in kincade_population.TABLES.values()})}
    geo, acs = kincade_population.extract_subset(bulk["tiger/tl_2018_06_bg.zip"], bulk["acs/g20185ca.txt"], seqs)
    return {
        "derived/zenodo-sheet1-cells.csv": kincade_traffic.workbook_cells_csv(bulk["zenodo/data_routine_evacuation.xlsx"]),
        "derived/tiger2018-bg-subset.geojson": geo,
        "derived/tiger2018-place-subset.geojson": kincade_population.extract_places(bulk["tiger/tl_2018_06_place.zip"]),
        "derived/acs2018-bg-subset.json": acs,
        "derived/firms-modis-subset.csv": kincade_fire.firms_subset(bulk["firms/modis_2019_United_States.csv"]),
        "derived/firms-viirs-snpp-subset.csv": kincade_fire.firms_subset(bulk["firms/viirs-snpp_2019_United_States.csv"]),
    }


def build(source_dir: Path, output_root: Path) -> Path:
    data = read_sources(source_dir)
    acquisition = load_json(data["acquisition.json"], "acquisition.json")
    raw = {n: data[n] for n in RAW_SOURCES}
    bulk = {n: data[n] for n in BULK_SOURCES}
    digests = {n: file_digest(d) for n, d in sorted({**raw, **bulk}.items())}
    for name in REFERENCE_DOCS:
        path = source_dir / name
        if path.is_file():
            digests[name] = {**file_digest(path.read_bytes()), "packaged": False}
    derived = derive_subsets(bulk)
    for name, blob in derived.items():
        digests[name] = {**file_digest(blob), "kind": "derived_subset", "method": SUBSET_METHODS[name]}
    curated = {p: src.read_bytes() for p, src in CURATED.items()}
    files = assemble(raw, derived, curated, acquisition, digests)
    version = load_json(files["manifest.json"], "manifest")["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="kincade-", dir=output_root) as temp_dir:
        temporary = Path(temp_dir)
        for name, blob in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(temporary), str(target))
    return target


def verify(package: Path) -> dict:
    manifest = load_json((package / "manifest.json").read_bytes(), "manifest")
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("package identity or normalizer version mismatch")
    listed = {}
    for item in manifest["artifacts"]:
        blob = (package / item["path"]).read_bytes()
        if len(blob) != item["bytes"] or sha256(blob) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
        listed[item["path"]] = blob
    on_disk = {str(p.relative_to(package)) for p in package.rglob("*") if p.is_file()}
    if on_disk != set(listed) | {"manifest.json"}:
        raise SourceError(f"unlisted or missing files: {sorted(on_disk ^ (set(listed) | {'manifest.json'}))}")
    sources = load_json(listed["sources.json"], "sources.json")
    digests = sources["_files"]
    raw = {}
    for name, (path, mode) in RAW_SOURCES.items():
        blob = listed[path]
        raw[name] = gunzip_checked(blob, digests[name]["sha256"], path) if mode == "gz" else blob
        if mode == "copy" and sha256(blob) != digests[name]["sha256"]:
            raise SourceError(f"raw copy differs from recorded source: {path}")
    derived = {p[:-3]: gunzip_checked(b, digests[p[:-3]]["sha256"], p)
               for p, b in listed.items() if p.startswith("derived/")}
    curated = {p: listed[p] for p in CURATED}
    acquisition = load_json(listed["raw/acquisition.json"], "acquisition")
    rebuilt = assemble(raw, derived, curated, acquisition, digests)
    if set(rebuilt) != set(listed) | {"manifest.json"}:
        raise SourceError("artifact list differs from reproducible build")
    for name, blob in rebuilt.items():
        if (package / name).read_bytes() != blob:
            raise SourceError(f"offline normalization mismatch: {name}")
    if package.name != manifest["package_version"]:
        raise SourceError("package directory and version differ")
    return {"package_version": manifest["package_version"],
            "layers": {k: v["status"] for k, v in manifest["layers"].items()},
            "counts": {i["path"]: i["count"] for i in manifest["artifacts"] if "count" in i},
            "total_bytes": sum(i["bytes"] for i in manifest["artifacts"])}


# --------------------------------------------------------------------------- acquisition
def _curl(args: list[str], out: Path, max_time: int = 900, attempts: int = 4) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_suffix(out.suffix + ".part")
    for attempt in range(1, attempts + 1):
        result = subprocess.run(["curl", "--http1.1", "--fail", "--silent", "--show-error", "--location",
                                 "--max-time", str(max_time), "-o", str(part), *args],
                                capture_output=True, check=False, timeout=max_time + 60)
        if result.returncode == 0:
            part.replace(out)
            return
        if attempt < attempts:
            time.sleep(15 * attempt)
    raise SourceError(f"download failed for {out.name}: {result.stderr.decode(errors='replace').strip()}")


def fetch(source_dir: Path) -> None:
    """Re-acquire every source with fixed endpoints (slow; Overpass one tile at a time)."""
    for i, tile in enumerate(kincade_roads.TILES, 1):
        _curl(["--data-urlencode", f"data={kincade_roads.overpass_query(tile)}", kincade_roads.OVERPASS_URL],
              source_dir / f"osm/tile{i}.json", max_time=1500)
    for name in ("data_routine_evacuation.xlsx", "data_routine_weeks.xlsx"):
        _curl([f"https://zenodo.org/api/records/7410114/files/{name}/content"], source_dir / "zenodo" / name)
    for layer in kincade_zones.LAYER_NAMES:
        _curl(["--get", "--data-urlencode", "where=1=1", "--data-urlencode", "outFields=*",
               "--data-urlencode", "outSR=4326", "--data-urlencode", "f=geojson",
               f"{ZONE_SERVICE}/{layer}/FeatureServer/0/query"], source_dir / f"zones/feat_{layer}.geojson")
    _curl([kincade_events.CALFIRE_URL], source_dir / "misc/calfire-2019.json")
    _curl(["--get", *sum((["--data-urlencode", f"{k}={v}"] for k, v in kincade_fire.FEDS_QUERY.items()), []),
           kincade_fire.FEDS_URL], source_dir / "feds/feds-F15031.json")
    _curl(["--get", "--data-urlencode", f"where=INCIDENTNAME='Kincade' AND INCIDENTNUM='{INCIDENT_NUMBER}'",
           "--data-urlencode", f"outFields={','.join(kincade_fire.DINS_FIELDS)}", "--data-urlencode", "outSR=4326",
           "--data-urlencode", "orderByFields=OBJECTID", "--data-urlencode", "resultRecordCount=2000",
           "--data-urlencode", "f=json", f"{kincade_fire.DINS_URL}/query"], source_dir / "dins/dins-kincade.json")
    _curl(["--get", *sum((["--data-urlencode", f"{k}={v}"] for k, v in kincade_traffic.POSTMILE_QUERY.items()), []),
           f"{kincade_traffic.POSTMILE_URL}/query"], source_dir / "misc/pm101.json")
    _curl([kincade_population.PLACE_URL], source_dir / "tiger/tl_2018_06_place.zip", max_time=1800)
    _curl([kincade_population.TIGER_URL], source_dir / "tiger/tl_2018_06_bg.zip", max_time=1800)
    _curl([f"{kincade_population.ACS_BASE}/g20185ca.txt"], source_dir / "acs/g20185ca.txt", max_time=1800)
    for seq in sorted({v[0] for v in kincade_population.TABLES.values()}):
        _curl([f"{kincade_population.ACS_BASE}/20185ca{seq}000.zip"], source_dir / f"acs/20185ca{seq}000.zip")
    for product, rel in kincade_fire.FIRMS_FILES.items():
        _curl([f"{kincade_fire.FIRMS_BASE}/{rel}"], source_dir / f"firms/{Path(rel).name}", max_time=1800)
    print("fetched; write acquisition.json with per-source access dates before building")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", choices=("fetch", "build"))
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
    elif args.command == "fetch" and args.sources:
        fetch(args.sources)
    elif args.command == "build" and args.sources:
        print(build(args.sources, args.output_root))
    else:
        parser.error("use fetch/build with --sources, or --verify-package")


if __name__ == "__main__":
    main()
