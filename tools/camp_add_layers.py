"""Add zones, order/warning/fire/burnover/shelter events, population, refuge areas,
calibration targets, NIST fire observations and FIRMS detections to the Camp package.

Inputs are the frozen curated tables in ``tools/camp_*_table.json`` and the
deterministic source subsets written by ``tools.camp_extracts``. The result is a
new immutable child package of the road-events package. ``--verify-package``
rebuilds every normalized layer offline from the packaged bytes.
"""

from __future__ import annotations

import argparse
import copy
import csv
import io
import json
import math
import re
import shutil
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from tools.add_camp_codedred import normalize_events as normalize_codedred
from tools.add_camp_road_events import normalize_road_events, verify as verify_road_events
from tools.camp_terrain import terrain_grid
from tools.build_camp_evacuation import (
    INCIDENT_ID, SourceError, artifact, encoded_json, feature_collection, normalize_roads, sha256,
)


NORMALIZER_VERSION = "camp-layers-1"
TOOLS = Path(__file__).parent
TABLES = {
    "curated/nist-zone-requests-table.json": TOOLS / "camp_zone_requests_table.json",
    "curated/nist-burnovers-table.json": TOOLS / "camp_burnovers_table.json",
    "curated/nist-tra-shelters-table.json": TOOLS / "camp_shelters_table.json",
    "curated/calibration-targets-table.json": TOOLS / "camp_calibration_table.json",
    "curated/displacement-table.json": TOOLS / "camp_displacement_table.json",
}
PACIFIC = ZoneInfo("America/Los_Angeles")
UTC = ZoneInfo("UTC")
TN2252_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf"
SUP_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf"
AAR_URL = ("https://www.caloes.ca.gov/wp-content/uploads/Preparedness/Documents/"
           "FINAL-AAR-2018-Camp-Fire-508-Clean-Copy-11.17.25.pdf")
ZONE_SYSTEM = ("Butte County / Town of Paradise evacuation zones as labelled in NIST TN 2252 Table 11 "
               "(Town 'Emergency Fire Zones' map PDF created 2018-05-30)")
EXCEL_EPOCH = date(1899, 12, 30)
# The NIST workbook stores 44508/44509 (2021-11-08/09); TN 2135 and TN 2252 document 2018-11-08/09.
WORKBOOK_DATE_SHIFT_DAYS = (date(2021, 11, 8) - date(2018, 11, 8)).days
PRIVATE_ROUNDING_DEG = 3
DEM_RAW_DIR = "raw/usgs-3dep-1as-n40w122/"
DEM_FULL = {"url": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/n40w122/USGS_1_n40w122.tif",
            "bytes": 56309277, "sha256": "f1b945a0bf79e77972dd9e87f42d2a5c70077802098d4b8d815b8be04b8d250a",
            "last_modified": "Thu, 15 May 2025 18:03:08 GMT"}
FIRMS_TYPE = {"0": "presumed vegetation fire", "1": "active volcano", "2": "other static land source", "3": "offshore"}


def utc_text(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_clock(day: str, text: str) -> datetime:
    """Parse NIST 'hh:mm' where hours >= 24 continue into the following day."""
    match = re.fullmatch(r"(\d{2}):(\d{2})", text or "")
    if not match or int(match[1]) > 47 or int(match[2]) > 59:
        raise SourceError(f"invalid local clock time {text!r}")
    base = datetime.fromisoformat(day).replace(tzinfo=PACIFIC)
    return base + timedelta(hours=int(match[1]), minutes=int(match[2]))


def as_written(day: str, text: str) -> str:
    local = local_clock(day, text)
    return f"{local.month}/{local.day} {local.strftime('%H:%M')}"


def minutes_text(delta_min: int) -> str:
    sign = "-" if delta_min < 0 else ""
    return f"{sign}{abs(delta_min) // 60:02d}:{abs(delta_min) % 60:02d}"


def base_event(event_id: str, kind: str, local: datetime, precision: str, written: str, source_id: str,
               locator: str, evidence: str, description: str, quote: str | None = None) -> dict:
    occurred = utc_text(local)
    return {
        "event_id": event_id, "type": kind, "occurred_at": occurred, "occurred_from": occurred,
        "occurred_to": utc_text(local + timedelta(minutes=1)), "time_precision": precision,
        "available_at": None, "available_at_status": "unknown",
        "available_at_reason": "retrospective NIST reconstruction; public availability not established",
        "local_time_as_written": written, "target": None, "geometry": None, "geocode_method": "unresolved",
        "description": description, "quote": quote, "evidence_class": evidence,
        "source_id": source_id, "source_locator": locator,
    }


# --- Zones, IC requests, ECC orders, first fire observations ------------------------------

def normalize_zone_requests(table_bytes: bytes) -> tuple[dict, list[dict]]:
    table = json.loads(table_bytes)
    if table.get("source_url") != TN2252_URL or table.get("time_zone") != "America/Los_Angeles":
        raise SourceError("zone request table has invalid source metadata")
    day = table["incident_local_date"]
    t11 = table["table_11"]
    locator = f"{TN2252_URL}#page={t11['pdf_page']}; Table 11; p. {t11['printed_page']}"
    zones = {zone["zone_id"]: zone for zone in table["zones"]}
    if len(zones) != len(table["zones"]):
        raise SourceError("duplicate zone IDs")
    checks = (("delta_warning_to_fire", "warning_request", "first_fire_data_point"),
              ("delta_order_to_fire", "order_request", "first_fire_data_point"),
              ("delta_warning_codered", "warning_request", "warning_codered"),
              ("delta_order_codered", "order_request", "order_codered"),
              ("delta_warning_to_order", "warning_request", "order_request"))
    events: list[dict] = []
    mentions: dict[str, list[str]] = {zone_id: [] for zone_id in zones}
    for row in t11["rows"]:
        zone_id, label = row["zone_id"], row["zone_as_written"]
        if zone_id not in zones:
            raise SourceError(f"Table 11 zone {label!r} missing from zone registry")
        times = {}
        for key in ("first_fire_data_point", "warning_request", "warning_codered", "order_request", "order_codered"):
            value = row[key]
            if value is not None and re.fullmatch(r"\d{2}:\d{2}", value):
                times[key] = local_clock(day, value)
            elif value not in (None, "n/d", "no fire", "> Nov 9") or (value and key != "first_fire_data_point"):
                raise SourceError(f"invalid Table 11 value {value!r} for {label}")
        for delta_key, start, end in checks:
            if row[delta_key] is None:
                continue
            if start not in times or end not in times:
                raise SourceError(f"Table 11 delta without both times: {label} {delta_key}")
            computed = minutes_text(int((times[end] - times[start]).total_seconds() // 60))
            if computed != row[delta_key]:
                raise SourceError(f"Table 11 transcription check failed: {label} {delta_key} {computed} != {row[delta_key]}")
        slug = zone_id.split("-zone-")[1]
        for key, kind, role in (("warning_request", "evacuation_warning", "warning"),
                                ("order_request", "evacuation_order", "order")):
            if key not in times:
                continue
            event = base_event(
                f"nist-tn2252:t11:{slug}:{role}-request", kind, times[key], "minute", as_written(day, row[key]),
                "nist-tn2252", f"{locator}; row {label}", "reconstructed",
                f"Incident Commander requested an evacuation {role} for {label}.")
            event.update({"target": {"zone_ids": [zone_id]}, "issuing_authority": "Incident Commander",
                          "time_role": "IC request time; dissemination to the public may be later (see alert_sent events)"})
            events.append(event)
            mentions[zone_id].append(event["event_id"])
        if "first_fire_data_point" in times:
            event = base_event(
                f"nist-tn2252:t11:{slug}:first-fire", "fire_arrival", times["first_fire_data_point"], "minute",
                as_written(day, row["first_fire_data_point"]), "nist-tn2252", f"{locator}; row {label}",
                "reconstructed", f"First documented fire observation in {label}.")
            event.update({"target": {"zone_ids": [zone_id]},
                          "time_role": "first documented fire observation; fire may have arrived earlier"})
            events.append(event)
            mentions[zone_id].append(event["event_id"])
    for row in table["table_10_ecc_rows"]:
        if any(zone_id not in zones for zone_id in row["zone_ids"]):
            raise SourceError(f"ECC row {row['id']} references an unknown zone")
        local = local_clock(day, row["local_time"])
        event = base_event(
            row["id"], row["type"], local, "minute", as_written(day, row["local_time"]), "nist-tn2252",
            f"{TN2252_URL}#page={row['pdf_page']}; Table 10; p. {row['printed_page']}; source {row['source_number']}",
            "reconstructed", row["description"], row["quote"])
        target = {"zone_ids": row["zone_ids"]}
        if row["place_names"]:
            target["place_names"] = row["place_names"]
        event.update({"target": target, "issuing_authority": row["issuer"], "zones_as_written": row["zones_as_written"],
                      "time_role": "ECC issuance/dissemination time as reconstructed by NIST"})
        events.append(event)
        for zone_id in row["zone_ids"]:
            mentions[zone_id].append(event["event_id"])
    for row in table["incident_events"]:
        local = local_clock(day, row["local_time"])
        event = base_event(
            row["id"], row["type"], local, row["time_precision"], as_written(day, row["local_time"]), "nist-tn2252",
            f"{TN2252_URL}#page={row['pdf_page']}; Sec. 1.2; p. {row['printed_page']}", "reconstructed",
            row["description"], row["quote"])
        if row["time_precision"] == "approximate":
            event["occurred_from"], event["occurred_to"] = None, None
            event["occurred_window_status"] = "unknown"
            event["occurred_window_reason"] = "source says 'approximately' without a stated range"
        event["target"] = {"place_name": row["place_name"]}
        events.append(event)
    features = []
    for zone_id, zone in sorted(zones.items()):
        features.append({"type": "Feature", "id": zone_id, "geometry": None, "properties": {
            "zone_id": zone_id, "name": zone["name_expanded"] or zone["name_as_written"],
            "name_as_written": zone["name_as_written"], "name_expanded": zone["name_expanded"],
            "community": zone["community"], "zone_system_version": ZONE_SYSTEM,
            "geometry_status": "missing",
            "geometry_reason": ("2018 zone polygons not found in machine-readable form; the 2018 Town map PDF is "
                                "vector artwork without georeferencing and copy-restricted; public ArcGIS layers "
                                "found are 2020/2025 uploads with no stated license"),
            "event_ids": sorted(mentions[zone_id]), "evidence_class": "reconstructed",
            "source_id": "nist-tn2252", "source_locator": locator,
        }})
    return feature_collection(features), events


# --- Burnovers (aggregate) -----------------------------------------------------------------

def normalize_burnovers(table_bytes: bytes) -> list[dict]:
    table = json.loads(table_bytes)
    if table.get("source_url") != TN2252_URL or table.get("table") != "30":
        raise SourceError("burnover table has invalid source metadata")
    events, seen = [], set()
    for row in table["rows"]:
        bid = row["burnover_id"]
        if bid in seen or row["initiation_footnotes"] not in ([], ["e"], ["g"]):
            raise SourceError(f"invalid burnover row {bid}")
        seen.add(bid)
        day = "2018-11-09" if "g" in row["initiation_footnotes"] else table["default_local_date"]
        local = local_clock(day, row["initiation_local"])
        duration = row["duration_as_written"]
        duration_min = int(duration) if re.fullmatch(r"\d+", duration) else None
        if duration_min is None and duration not in ("n/d", "n/a"):
            raise SourceError(f"invalid burnover duration {duration!r}")
        fatalities = row["fatalities_as_written"]
        if fatalities is not None and not re.fullmatch(r"\d+", fatalities):
            raise SourceError(f"invalid burnover fatalities {fatalities!r}")
        event = base_event(
            f"nist-tn2252:t30:bo-{bid:02d}", "burnover", local, "approximate", as_written(day, row["initiation_local"]),
            "nist-tn2252", f"{TN2252_URL}#page={row['pdf_page']}; Table 30; p. {row['printed_page']}; BO #{bid}",
            "reconstructed", f"Burnover #{bid} at {row['location_as_written']} ({row['community']}).")
        event["occurred_from"], event["occurred_to"] = None, None
        event["occurred_window_status"] = "unknown"
        event["occurred_window_reason"] = ("first observation; burnover existed earlier" if "e" in row["initiation_footnotes"]
                                           else "NIST initiation time without stated uncertainty")
        event.update({
            "target": {"osm_way_ids": None, "osm_way_ids_status": "unresolved",
                       "road_name": row["location_as_written"], "place_name": row["community"]},
            "burnover_id": bid, "severity_category": row["severity_category"],
            "duration_min": duration_min,
            "duration_status": "published" if duration_min is not None else ("unknown" if duration == "n/d" else "not_applicable"),
            "active_until": utc_text(local + timedelta(minutes=duration_min)) if duration_min is not None else None,
            "fatalities_count": int(fatalities) if fatalities else None,
            "fatalities_status": "published" if fatalities else "blank_in_source",
            "time_role": "burnover initiation per NIST Table 30",
        })
        events.append(event)
    return events


# --- Temporary refuge areas and shelters ---------------------------------------------------

def parse_count(text: str | None) -> dict:
    if text in (None, "n/d", "n/a"):
        return {"min": None, "max": None, "status": {"n/d": "no_data", "n/a": "not_applicable"}.get(text, "not_reported"),
                "as_written": text}
    match = re.fullmatch(r"(\d+)(?: to (\d+))?(?: \((.+)\))?", text)
    if not match:
        raise SourceError(f"invalid TRA count {text!r}")
    low = int(match[1])
    return {"min": low, "max": int(match[2] or low), "status": "published", "qualifier": match[3], "as_written": text}


def parse_periods(text: str) -> list[tuple[datetime, datetime]]:
    periods = []
    for part in text.split(" and "):
        match = re.fullmatch(r"November (\d+), (\d{2}:\d{2})\s*–\s*(?:November (\d+), )?(\d{2}:\d{2})", part.strip())
        if not match:
            raise SourceError(f"invalid TRA date/time {text!r}")
        start = local_clock(f"2018-11-{int(match[1]):02d}", match[2])
        end = local_clock(f"2018-11-{int(match[3] or match[1]):02d}", match[4])
        if end <= start:
            raise SourceError(f"TRA period ends before it starts: {text!r}")
        periods.append((start, end))
    return periods


def normalize_shelters(table_bytes: bytes) -> tuple[dict, list[dict]]:
    table = json.loads(table_bytes)
    if table.get("source_url") != SUP_URL:
        raise SourceError("shelter table has invalid source metadata")
    features, events = [], []
    for row in table["temporary_refuge_areas"]:
        periods = parse_periods(row["date_time_as_written"])
        durations = [f"{int((e - s).total_seconds() // 3600)} h {int((e - s).total_seconds() % 3600 // 60)} min"
                     for s, e in periods]
        if ", ".join(durations) != re.sub(r"\s+", " ", row["duration_as_written"]):
            raise SourceError(f"TRA duration check failed for {row['tra_id']}: {durations}")
        lat, lon = float(row["latitude_as_written"]), float(row["longitude_as_written"])
        if not (39.5 < lat < 40.1 and -122.0 < lon < -121.3):
            raise SourceError(f"TRA coordinate outside study area: {row['tra_id']}")
        if row["private_parcel"]:
            lat, lon = round(lat, PRIVATE_ROUNDING_DEG), round(lon, PRIVATE_ROUNDING_DEG)
        letter = row["tra_id"].split("-")[1]
        shelter_id = f"nist-tra:{letter}"
        locator = f"{SUP_URL}#page={row['pdf_page']}; Appendix I; p. {row['printed_page']}; {row['tra_id']}"
        persons, vehicles = parse_count(row.get("civilian_headcount_as_written")), parse_count(row.get("civilian_vehicle_count_as_written"))
        area = re.match(r"([\d.]+) ha", row["area_as_written"])
        features.append({"type": "Feature", "id": shelter_id,
                         "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {
            "shelter_id": shelter_id, "tra_id": row["tra_id"], "name": row["name_as_written"],
            "kind": "temporary_refuge", "tra_type": row["tra_type"],
            "opened_at": utc_text(periods[0][0]), "closed_at": utc_text(periods[-1][1]),
            "active_periods_utc": [[utc_text(s), utc_text(e)] for s, e in periods],
            "time_precision": "minute", "time_role": "NIST-reconstructed TRA use period",
            "local_time_as_written": row["date_time_as_written"],
            "capacity_persons": None, "capacity_persons_status": "unknown",
            "capacity_persons_reason": "NIST reports area and occupant ranges, not a capacity",
            "area_ha": float(area[1]) if area else None,
            "occupancy_reports": [{"period": "TRA active period", "persons": persons, "vehicles": vehicles}],
            "pre_planned": row["pre_planned_as_written"].startswith("Yes"),
            "pre_planned_as_written": row["pre_planned_as_written"],
            "location_as_written": row["location_as_written"],
            "location_precision": "rounded_0.001_deg_private_parcel" if row["private_parcel"] else "nist_coordinates",
            "geocode_method": "source_coordinates",
            "evidence_class": "derived" if row["private_parcel"] else "reconstructed",
            "source_id": "nist-nettra-supplement", "source_locator": locator,
        }})
        for index, (start, end) in enumerate(periods):
            for kind, moment, verb in (("shelter_opened", start, "formed"), ("shelter_closed", end, "ended")):
                event = base_event(
                    f"{shelter_id}:{index}:{kind.split('_')[1]}", kind, moment, "minute",
                    f"{moment.month}/{moment.day} {moment.strftime('%H:%M')}", "nist-nettra-supplement", locator,
                    "reconstructed", f"Temporary refuge area {row['tra_id']} ({row['name_as_written']}) {verb}.")
                event.update({"target": {"shelter_id": shelter_id}, "shelter_kind": "temporary_refuge",
                              "geometry": {"type": "Point", "coordinates": [lon, lat]},
                              "geocode_method": "shelter_point",
                              "time_role": "start/end of NIST-reconstructed TRA use"})
                events.append(event)
    for row in table["other_shelters"]:
        features.append({"type": "Feature", "id": row["shelter_id"], "geometry": None, "properties": {
            "shelter_id": row["shelter_id"], "name": row["name"], "kind": row["kind"],
            "opened_at": None, "opened_at_status": "day_only", "opened_local_date": row["opened_local_date"],
            "closed_at": None, "closed_at_status": "unknown", "time_precision": row["opened_time_precision"],
            "capacity_persons": None, "capacity_persons_status": "unknown",
            "capacity_persons_reason": "capacity not stated in source", "occupancy_reports": [],
            "operator_note_as_written": row["operator_note_as_written"], "geocode_method": "unresolved",
            "evidence_class": "reported", "source_id": row["source_id"],
            "source_locator": f"{AAR_URL}#page={row['pdf_page']}; p. {row['printed_page']}", "quote": row["quote"],
        }})
    return feature_collection(features), events


def normalize_displacement(table_bytes: bytes) -> dict:
    table = json.loads(table_bytes)
    ids = [record["record_id"] for record in table["records"]]
    if len(ids) != len(set(ids)) or any(record["temporal_role"] != "post_event" for record in table["records"]):
        raise SourceError("invalid displacement table")
    return {"rule": "aggregate published figures only", "records": sorted(table["records"], key=lambda r: r["record_id"])}


def normalize_calibration(table_bytes: bytes) -> dict:
    table = json.loads(table_bytes)
    ids = [target["target_id"] for target in table["targets"]]
    if len(ids) != len(set(ids)):
        raise SourceError("duplicate calibration target IDs")
    for target in table["targets"]:
        if target["evidence_class"] not in ("observed", "reported", "reconstructed") or not target["source_locator"]:
            raise SourceError(f"invalid calibration target {target['target_id']}")
        if isinstance(target["value"], (int, float)) and target["value"] < 0:
            raise SourceError(f"negative calibration value {target['target_id']}")
    return {"time_zone": "America/Los_Angeles", "rule": "published numbers only; no values estimated by CrisisTwin",
            "targets": sorted(table["targets"], key=lambda target: target["target_id"])}


# --- Population (ACS 2014-2018 5-year, TIGER 2018 block groups) ---------------------------

def ring_area(ring: list[list[float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def rings_to_multipolygon(parts: list[list[list[float]]]) -> dict:
    from tools.camp_extracts import point_in_ring

    outers = [[ring] for ring in parts if ring_area(ring) < 0]  # shapefile outer rings are clockwise
    for ring in parts:
        if ring_area(ring) >= 0:
            owner = next((poly for poly in outers if point_in_ring(ring[0][0], ring[0][1], poly[0])), None)
            if owner is None:
                raise SourceError("TIGER hole without containing outer ring")
            owner.append(ring)
    if not outers:
        raise SourceError("TIGER polygon has no outer ring")
    # GeoJSON (RFC 7946) winding: exterior counter-clockwise, holes clockwise.
    return {"type": "MultiPolygon", "coordinates": [[list(reversed(poly[0]))] + [list(reversed(h)) for h in poly[1:]]
                                                     for poly in outers]}


def acs_positions(lookup: bytes) -> dict[str, tuple[str, int]]:
    starts: dict[str, tuple[str, int]] = {}
    for row in csv.DictReader(io.StringIO(lookup.decode("latin-1"))):
        if row["Start Position"]:
            starts[row["Table ID"]] = (row["Sequence Number"], int(row["Start Position"]))
    return starts


def acs_cells(files: dict[str, bytes], kind: str, seq: str) -> dict[str, list[str]]:
    rows = {}
    for line in files[f"raw/extracts/acs2018/{kind}20185ca{seq}000-subset.txt"].decode("latin-1").splitlines():
        cells = line.split(",")
        rows[cells[5]] = cells
    return rows


def normalize_population(files: dict[str, bytes]) -> tuple[dict, dict]:
    tiger = json.loads(files["raw/extracts/tiger2018-bg-subset.json"])
    starts = acs_positions(files["raw/extracts/acs2018/seq-table-lookup-subset.csv"])
    geo = {}
    for line in files["raw/extracts/acs2018/g20185ca-subset.txt"].decode("latin-1").splitlines():
        geo[line[178:218].strip()[7:]] = {"logrecno": line[13:20], "name": line[218:418].strip()}
    cache = {(kind, seq): acs_cells(files, kind, seq) for kind in "em" for seq in {s for s, _ in starts.values()}}

    def cell(kind: str, table: str, line_no: int, logrecno: str) -> int | None:
        seq, start = starts[table]
        text = cache[(kind, seq)][logrecno][start - 1 + line_no - 1].strip()
        if not re.fullmatch(r"-?\d+", text) or (kind == "m" and int(text) < 0):
            return None
        return int(text)

    def total(table: str, lines: list[int], logrecno: str) -> tuple[int | None, int | None]:
        values = [cell("e", table, n, logrecno) for n in lines]
        moes = [cell("m", table, n, logrecno) for n in lines]
        estimate = None if None in values else sum(values)
        moe = None if None in moes else round(math.sqrt(sum(m * m for m in moes)))
        return estimate, moe

    features = []
    for record in tiger["records"]:
        attrs = record["attributes"]
        geoid = attrs["GEOID"]
        if geoid not in geo:
            raise SourceError(f"ACS geography lacks {geoid}")
        lr = geo[geoid]["logrecno"]
        pop65, pop65_moe = total("B01001", list(range(20, 26)) + list(range(44, 50)), lr)
        by_vehicle = {}
        for label, owner_line in (("0", 3), ("1", 4), ("2", 5), ("3", 6), ("4", 7), ("5_plus", 8)):
            estimate, moe = total("B25044", [owner_line, owner_line + 7], lr)
            by_vehicle[label] = {"households": estimate, "moe": moe}
        props = {
            "geoid": geoid, "name": geo[geoid]["name"], "county_fips": attrs["STATEFP"] + attrs["COUNTYFP"],
            "tract": attrs["TRACTCE"], "block_group": attrs["BLKGRPCE"],
            "aland_m2": attrs["ALAND"], "awater_m2": attrs["AWATER"],
            "population": cell("e", "B01003", 1, lr), "moe_population": cell("m", "B01003", 1, lr),
            "households": cell("e", "B11001", 1, lr), "moe_households": cell("m", "B11001", 1, lr),
            "occupied_housing_units": cell("e", "B25044", 1, lr), "moe_occupied_housing_units": cell("m", "B25044", 1, lr),
            "households_by_vehicles_available": by_vehicle,
            "households_no_vehicle": by_vehicle["0"]["households"], "moe_households_no_vehicle": by_vehicle["0"]["moe"],
            "vehicles_available_total": cell("e", "B25046", 1, lr), "moe_vehicles_available_total": cell("m", "B25046", 1, lr),
            "population_65_plus": pop65, "moe_population_65_plus": pop65_moe,
            "acs_vintage": "ACS 2014-2018 5-year", "geometry_vintage": "TIGER/Line 2018 block groups",
            "evidence_class": "observed", "source_id": "acs2018-5yr-summary-file",
            "source_locator": f"ACS 2018 5-year summary file, CA tracts/BG sequences; logical record {lr}",
        }
        for key in [k for k, v in props.items() if v is None]:
            props[f"{key}_status"] = "unknown"
            props[f"{key}_reason"] = "blank or annotated cell in the ACS summary file (not published for this geography)"
        features.append({"type": "Feature", "id": f"bg:{geoid}", "geometry": rings_to_multipolygon(record["parts"]),
                         "properties": props})
    summary = {
        "block_group_count": len(features),
        "population_sum": sum(f["properties"]["population"] or 0 for f in features),
        "household_sum": sum(f["properties"]["households"] or 0 for f in features),
        "derived_fields": {
            "households_by_vehicles_available": "B25044 owner + renter lines summed; MOE by root-sum-of-squares (Census approximation)",
            "population_65_plus": "B01001 lines 20-25 and 44-49 summed; MOE by root-sum-of-squares",
            "coordinates": "TIGER NAD83 longitude/latitude used as OGC:CRS84 without datum shift (sub-2 m)",
        },
        "selection": tiger["selection"],
    }
    return feature_collection(features), summary


# --- NIST fire observations and FIRMS detections ------------------------------------------

def normalize_fire_observations(data: bytes) -> dict:
    source = json.loads(data)
    groups: dict[tuple, dict] = {}
    for row in source["rows"]:
        key = tuple(row[name] for name in sorted(source["kept_columns"].values())) + (row["observation_text_sha256_12"],)
        group = groups.setdefault(key, {"row": row, "sheets": []})
        group["sheets"].append(f"{row['sheet']}!{row['row']}")
    features = []
    for key, group in sorted(groups.items(), key=lambda item: (float(item[1]["row"]["date_serial"] or 0),
                                                              float(item[1]["row"]["time_fraction"] or 0), str(item[0]))):
        row = group["row"]
        props = {
            "source_number": row["source_number"], "time_source": row["time_source"],
            "location_source": row["location_source"], "info_source": row["info_source"],
            "type_of_fire_code": row["type_of_fire"], "type_of_fire_code_status": "code meaning per NIST TN 2135 key; not expanded here",
            "residual_fire": row["residual_fire"] == "x", "ssi_flag": row["ssi"] == "x",
            "workbook_date_serial": row["date_serial"], "workbook_time_fraction": row["time_fraction"],
            "corridor_sheet_rows": sorted(group["sheets"]),
            "evidence_class": "reconstructed", "source_id": "nist-fire-observations",
        }
        try:
            serial = int(row["date_serial"])
            minutes = float(row["time_fraction"]) * 1440
        except (TypeError, ValueError):
            serial = None
        if serial is None or not 0 <= minutes < 1440 or abs(minutes - round(minutes)) > 1e-3:
            props.update({"observed_at": None, "observed_at_status": "unknown",
                          "observed_at_reason": "workbook date/time not parseable to a minute"})
        else:
            workbook_day = EXCEL_EPOCH + timedelta(days=serial)
            corrected = workbook_day - timedelta(days=WORKBOOK_DATE_SHIFT_DAYS)
            if corrected not in (date(2018, 11, 8), date(2018, 11, 9)):
                raise SourceError(f"unexpected fire-observation date {workbook_day}")
            local = datetime.combine(corrected, datetime.min.time(), PACIFIC) + timedelta(minutes=round(minutes))
            raw_window = float(row["obs_window_min"] or 0)
            window = round(raw_window)
            if abs(raw_window - window) > 1e-3 or window < 0:
                raise SourceError(f"non-integer observation window {row['obs_window_min']!r}")
            props.update({
                "observed_at": utc_text(local), "observed_from": utc_text(local),
                "observed_to": utc_text(local + timedelta(minutes=window or 1)),
                "time_precision": "approximate" if window else "minute", "observation_window_min": window,
                "local_time_as_written": f"{workbook_day.isoformat()} {local.strftime('%H:%M')}",
                "date_correction": "derived: workbook serial date 2021 shifted to 2018 per NIST TN 2135/TN 2252 incident date",
            })
        lat, lon = float(row["latitude"]), float(row["longitude"])
        features.append({"type": "Feature", "id": f"nist-fireobs:{len(features) + 1:04d}",
                         "geometry": {"type": "Point", "coordinates": [lon, lat]},
                         "properties": {"observation_id": f"nist-fireobs:{len(features) + 1:04d}", **props}})
    return feature_collection(features)


def normalize_firms(name: str, data: bytes) -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(data.decode())))
    features = []
    for row in rows:
        acquired = datetime.strptime(row["acq_date"] + row["acq_time"].zfill(4), "%Y-%m-%d%H%M").replace(tzinfo=UTC)
        instrument = row["instrument"]
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(row["longitude"]), float(row["latitude"])]},
                         "properties": {
            "acquired_at": utc_text(acquired), "time_precision": "minute",
            "satellite": row["satellite"], "instrument": instrument,
            "confidence": row["confidence"],
            "confidence_scale": "percent 0-100" if instrument == "MODIS" else "categorical l/n/h",
            "frp_mw": float(row["frp"]), "daynight": row["daynight"],
            "brightness_k": float(row.get("brightness") or row.get("bright_ti4")),
            "brightness_band": "MODIS 21/22" if instrument == "MODIS" else "VIIRS I-4",
            "scan_km": float(row["scan"]), "track_km": float(row["track"]),
            "nominal_resolution_m": 1000 if instrument == "MODIS" else 375,
            "type_code": row["type"], "type_meaning": FIRMS_TYPE.get(row["type"]),
            "collection_version": row["version"], "processing": "FIRMS yearly country archive file",
            "evidence_class": "observed", "source_id": f"firms-{name}-2018-us",
        }})
    return features


def normalize_detections(files: dict[str, bytes]) -> dict:
    features = (normalize_firms("modis", files["raw/extracts/firms-modis-2018-us-subset.csv"])
                + normalize_firms("viirs-snpp", files["raw/extracts/firms-viirs-snpp-2018-us-subset.csv"]))
    features.sort(key=lambda f: (f["properties"]["acquired_at"], f["properties"]["instrument"],
                                 f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]))
    for index, feature in enumerate(features, 1):
        feature["id"] = f"firms:{index:05d}"
        feature["properties"]["detection_id"] = feature["id"]
    return feature_collection(features)


# --- Package assembly ----------------------------------------------------------------------

def check_extracts(files: dict[str, bytes]) -> dict:
    manifest = json.loads(files["raw/extracts/extraction_manifest.json"])
    names = {name[len("raw/extracts/"):] for name in files if name.startswith("raw/extracts/")} - {"extraction_manifest.json"}
    if names != set(manifest["extracts"]):
        raise SourceError("packaged extracts differ from extraction manifest")
    for name, item in manifest["extracts"].items():
        data = files[f"raw/extracts/{name}"]
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"extract checksum mismatch: {name}")
    return manifest


def normalized_layers(files: dict[str, bytes]) -> tuple[dict[str, bytes], dict]:
    extraction = check_extracts(files)
    zones, zone_events = normalize_zone_requests(files["curated/nist-zone-requests-table.json"])
    burnover_events = normalize_burnovers(files["curated/nist-burnovers-table.json"])
    shelters, shelter_events = normalize_shelters(files["curated/nist-tra-shelters-table.json"])
    calibration = normalize_calibration(files["curated/calibration-targets-table.json"])
    displacement = normalize_displacement(files["curated/displacement-table.json"])
    terrain = terrain_grid(files[f"{DEM_RAW_DIR}header.bin"],
                           {name[len(DEM_RAW_DIR):]: data for name, data in files.items()
                            if name.startswith(DEM_RAW_DIR) and name.endswith(".bin") and not name.endswith("header.bin")})
    population, population_summary = normalize_population(files)
    observations = normalize_fire_observations(files["raw/extracts/nist-fire-observations-subset.json"])
    detections = normalize_detections(files)
    prior = (normalize_codedred(files["curated/nist-codedred-table.json"])
             + normalize_road_events(files["curated/nist-road-events-table.json"]))
    events = sorted(prior + zone_events + burnover_events + shelter_events,
                    key=lambda event: (event["occurred_at"], event["event_id"]))
    if len({event["event_id"] for event in events}) != len(events):
        raise SourceError("duplicate event IDs")
    out = {
        "normalized/events.jsonl": b"".join(encoded_json(event) for event in events),
        "normalized/evacuation_zones.geojson": encoded_json(zones),
        "normalized/shelters.geojson": encoded_json(shelters),
        "normalized/calibration_targets.json": encoded_json(calibration),
        "normalized/population_units.geojson": encoded_json(population),
        "normalized/fire_observations_reconstructed.geojson": encoded_json(observations),
        "normalized/fire_detections.geojson": encoded_json(detections),
        "normalized/displacement.json": encoded_json(displacement),
        "normalized/terrain_grid.json": encoded_json(terrain),
    }
    stats = {
        "events": events, "zones": zones, "shelters": shelters, "calibration": calibration,
        "population": population, "population_summary": population_summary, "observations": observations,
        "detections": detections, "extraction": extraction, "displacement": displacement,
        "terrain": {k: v for k, v in terrain.items() if k != "elevation_m"},
        "new_event_counts": {"zone_requests_and_fire_arrivals": len(zone_events), "burnovers": len(burnover_events),
                             "shelters": len(shelter_events)},
    }
    return out, stats


def coverage(items: list[str]) -> list[str] | None:
    values = sorted(value for value in items if value)
    return [values[0], values[-1]] if values else None


def add_layers(base_package: Path, extracts_dir: Path, dem_dir: Path) -> dict[str, bytes]:
    verify_road_events(base_package)
    base_manifest = json.loads((base_package / "manifest.json").read_bytes())
    files = {item["path"]: (base_package / item["path"]).read_bytes() for item in base_manifest["artifacts"]}
    new_inputs: dict[str, bytes] = {name: path.read_bytes() for name, path in TABLES.items()}
    for path in sorted(extracts_dir.rglob("*")):
        if path.is_file():
            new_inputs[f"raw/extracts/{path.relative_to(extracts_dir).as_posix()}"] = path.read_bytes()
    for path in sorted(dem_dir.glob("*.bin")):
        new_inputs[f"{DEM_RAW_DIR}{path.name}"] = path.read_bytes()
    files.update(new_inputs)
    layers, stats = normalized_layers(files)
    files.update(layers)
    files["sources.json"] = encoded_json(updated_sources(json.loads(files["sources.json"]), stats["extraction"]))
    files["quality.json"] = encoded_json(updated_quality(json.loads(files["quality.json"]), stats))
    manifest = copy.deepcopy(base_manifest)
    manifest["parent_package_version"] = base_manifest["package_version"]
    manifest["layers_normalizer_version"] = NORMALIZER_VERSION
    manifest["package_version"] = package_version(base_manifest["package_version"], new_inputs)
    manifest["layers"].update(layer_status(stats))
    counts = {
        "normalized/events.jsonl": len(stats["events"]),
        "normalized/evacuation_zones.geojson": len(stats["zones"]["features"]),
        "normalized/shelters.geojson": len(stats["shelters"]["features"]),
        "normalized/calibration_targets.json": len(stats["calibration"]["targets"]),
        "normalized/population_units.geojson": len(stats["population"]["features"]),
        "normalized/fire_observations_reconstructed.geojson": len(stats["observations"]["features"]),
        "normalized/fire_detections.geojson": len(stats["detections"]["features"]),
        "normalized/displacement.json": len(stats["displacement"]["records"]),
    }
    manifest["artifacts"] = [artifact(path, data, counts.get(path)) for path, data in sorted(files.items())]
    files["manifest.json"] = encoded_json(manifest)
    return files


def package_version(parent: str, new_inputs: dict[str, bytes]) -> str:
    digest = parent.encode() + NORMALIZER_VERSION.encode()
    for name in sorted(new_inputs):
        digest += name.encode() + sha256(new_inputs[name]).encode()
    return sha256(digest)[:16]


def layer_status(stats: dict) -> dict:
    events = stats["events"]
    obs_times = [f["properties"].get("observed_at") for f in stats["observations"]["features"]]
    det_times = [f["properties"]["acquired_at"] for f in stats["detections"]["features"]]
    return {
        "events": {
            "status": "partial", "count": len(events),
            "time_coverage_utc": coverage([e["occurred_at"] for e in events]),
            "coverage": ("CodeRED alerts, 12 NIST road observations, NIST Table 11 IC warning/order requests and first "
                         "fire observations, 2 ECC order rows, ignition/first report, 23 burnovers, 31 TRA formation/end pairs"),
            "missing": "most NETTRA road observations, road reopenings, official shelter openings with times, facility evacuations",
        },
        "evacuation_zones": {
            "status": "partial", "count": len(stats["zones"]["features"]),
            "coverage": "zone registry (IDs, names, linked events) for all zones in NIST Table 11",
            "missing": "polygons: no machine-readable, licensed 2018 zone geometry found",
        },
        "population_units": {
            "status": "present", "count": len(stats["population"]["features"]),
            "acs_vintage": "2014-2018 5-year", "coverage": "all TIGER 2018 block groups intersecting the requested bbox",
            "zone_population_crosswalk": {"status": "missing", "reason": "zone polygons unavailable"},
        },
        "shelters": {
            "status": "partial", "count": len(stats["shelters"]["features"]),
            "coverage": "31 NIST temporary refuge areas with periods and occupant ranges; 1 county mass-care shelter (day-only)",
            "missing": "official evacuation shelters in Chico/Oroville/Gridley with opening times and capacities",
        },
        "calibration_targets": {
            "status": "partial", "count": len(stats["calibration"]["targets"]),
            "coverage": "NIST TN 2252 Tables 4, 6, 8, 13, 30, Sec. 7.2.2/9.1; Cal OES AAR statistical summary",
            "missing": "observed traffic volumes (PeMS requires account), survey departure shares",
        },
        "fire_progression_reconstructed": {
            "status": "partial", "count": len(stats["observations"]["features"]),
            "path": "normalized/fire_observations_reconstructed.geojson",
            "time_coverage_utc": coverage(obs_times),
            "coverage": "NIST geolocated fire observation points (deduplicated across corridor sheets); Table 11 first-fire events",
            "missing": "reconstructed arrival polygons/isochrones (figures not digitized)",
        },
        "displacement": {
            "status": "partial", "count": len(stats["displacement"]["records"]),
            "coverage": "Cal OES AAR aggregate post-event figures (population influx, FEMA IHP, direct housing, shelter closure)",
            "missing": "USPS/Census change-of-address, CA DOF 2018/2019 Paradise estimates, ZIP-level FEMA registrations",
        },
        "terrain": {
            "status": "present", "count": stats["terrain"]["ncols"] * stats["terrain"]["nrows"],
            "path": "normalized/terrain_grid.json", "ncols": stats["terrain"]["ncols"], "nrows": stats["terrain"]["nrows"],
            "coverage": "USGS 3DEP 1 arc-second (~24 x 31 m) cells covering the requested bbox; current 3DEP release (2025), not a 2018 vintage",
        },
        "buildings": {"status": "missing", "reason": "not attempted in this acquisition pass (OSM 2018 attic buildings / MS footprints pending)"},
        "street_imagery": {"status": "missing", "reason": "Mapillary needs a client token (none available); KartaView keyless API returned no photos at central Paradise per coordinator probe; Google imagery excluded by terms"},
        "media_evidence": {"status": "missing", "reason": "not attempted in this acquisition pass"},
        "fire_detections": {
            "status": "present", "count": len(stats["detections"]["features"]),
            "time_coverage_utc": coverage(det_times),
            "coverage": "FIRMS MODIS C6 and VIIRS S-NPP 375 m archive detections in bbox, acq_date 2018-11-08/09 UTC",
        },
    }


def updated_sources(sources: dict, extraction: dict) -> dict:
    nist_license = {"license": "NIST open license", "license_url": "https://www.nist.gov/open/license"}
    sources["nist-tn2252"] = {
        "provider": "National Institute of Standards and Technology", "landing_url": TN2252_URL,
        "title": "A Case Study of the Camp Fire - Notification, Evacuation, Traffic, and Temporary Refuge Areas (NETTRA), NIST TN 2252 (July 2023)",
        "source_sha256": "b9cdeed04f6c020b8af85e28ae300f8df467dc63a873832d72eadbc4d7dd5982", "source_bytes": 12355986,
        "source_copy_note": "hashed copy is the 278-page govinfo.gov GOVPUB rendition; an nvlpubs download in this environment was truncated",
        "raw_source_status": "not bundled: report cites individual 911 records; curated tables are frozen instead",
        "curated_paths": ["curated/nist-zone-requests-table.json", "curated/nist-burnovers-table.json",
                          "curated/calibration-targets-table.json"], **nist_license,
    }
    sources["nist-nettra-supplement"]["curated_paths"] = ["curated/nist-codedred-table.json",
                                                          "curated/nist-road-events-table.json",
                                                          "curated/nist-tra-shelters-table.json"]
    sources["caloes-camp-aar-2025"] = {
        "provider": "California Governor's Office of Emergency Services", "landing_url": AAR_URL,
        "title": "After Action Report: 2018 Camp Fire (508 clean copy, 2025-11-17)",
        "source_sha256": "fd3a2bfcddcd35608167e5e851f4707a1d5a722fce51aa5cd01c5de9c402e808", "source_bytes": 1901028,
        "license": "unknown (California state publication; no reuse license stated)", "raw_source_status": "not bundled; quoted facts only",
    }
    full = extraction["full_sources"]
    sources["acs2018-5yr-summary-file"] = {
        "provider": "U.S. Census Bureau", "dataset": "American Community Survey 2014-2018 5-year summary file",
        "full_downloads": {k: v for k, v in full.items() if k.startswith("acs2018")},
        "extract_paths": sorted(f"raw/extracts/{n}" for n in extraction["extracts"] if n.startswith("acs2018/")),
        "extraction": "derived: verbatim source lines for selected block groups (see tools/camp_extracts.py)",
        "license": "public domain (U.S. Government work)", "attribution": "U.S. Census Bureau, ACS 2014-2018 5-year",
    }
    sources["tiger2018-bg-ca"] = {
        "provider": "U.S. Census Bureau", "dataset": "TIGER/Line 2018 block groups, California",
        "full_download": full["tiger2018-bg-ca"], "extract_path": "raw/extracts/tiger2018-bg-subset.json",
        "extraction": "derived: lossless decoding of selected .shp/.dbf records", "license": "public domain (U.S. Government work)",
    }
    for key in ("modis", "viirs-snpp"):
        sources[f"firms-{key}-2018-us"] = {
            "provider": "NASA FIRMS (LANCE/EOSDIS)", "full_download": full[f"firms-{key}-2018-us"],
            "extract_path": f"raw/extracts/firms-{key}-2018-us-subset.csv",
            "extraction": "derived: verbatim CSV lines within bbox with acq_date 2018-11-08 or 2018-11-09 (UTC)",
            "license": "NASA open data (no restrictions; attribution requested)",
            "attribution": "NASA FIRMS, https://earthdata.nasa.gov/firms",
        }
    sources["nist-fire-observations"] = {
        "provider": "National Institute of Standards and Technology",
        "landing_url": "https://data.nist.gov/od/id/mds2-2954",
        "related_publication": "NIST TN 2135, A Case Study of the Camp Fire - Fire Progression Timeline (2021)",
        "full_download": full["nist-fire-observations"], "extract_path": "raw/extracts/nist-fire-observations-subset.json",
        "extraction": "derived: all geolocated rows; free-text 'Fire Behavior Observations' column dropped for privacy",
        **nist_license,
    }
    sources["usgs-3dep-1as-n40w122"] = {
        "provider": "U.S. Geological Survey, 3D Elevation Program", "full_download": DEM_FULL,
        "raw_paths": f"{DEM_RAW_DIR}header.bin (bytes 0-65535) and tile_r*_c*.bin (verbatim TIFF tile byte ranges)",
        "extraction": "derived: HTTP range copies of the header and the 20 LZW tiles intersecting the bbox; decoded with tools/camp_terrain.py",
        "vintage_note": "current 3DEP product (S3 Last-Modified 2025-05-15); pre-fire 2018 DEM vintage not established",
        "license": "public domain (U.S. Government work)", "attribution": "U.S. Geological Survey 3DEP",
    }
    sources["zone-polygon-candidates-not-used"] = {
        "items": [
            {"url": "https://www.nist.gov/document/paradise-ur-map", "sha256": "cbaa287dd2b9338c580344984a7a16101963cb210fb4c1bb2d51cb4535afa1ca",
             "reason": "2018 Town map PDF: vector artwork, not georeferenced, copy-restricted permissions"},
            {"url": "https://services8.arcgis.com/BlJqQfSNemkyeqGU/arcgis/rest/services/Paradise_Evacuation_Zones/FeatureServer",
             "reason": "ArcGIS item created 2025-03-04 by a third party; BUT-TOP Genasys-era zones; no license stated"},
            {"url": "https://services1.arcgis.com/afGgcgqM3caiSYv7/arcgis/rest/services/EvacZones/FeatureServer",
             "reason": "ArcGIS item created 2020-03-26, modified 2025; no license stated; post-fire vintage"},
        ],
    }
    return sources


def updated_quality(quality: dict, stats: dict) -> dict:
    quality["event_count"] = len(stats["events"])
    quality["new_event_counts"] = stats["new_event_counts"]
    quality["population_summary"] = stats["population_summary"]
    quality["fire_observation_unique_count"] = len(stats["observations"]["features"])
    quality["fire_detection_count"] = len(stats["detections"]["features"])
    quality["layer_limitations"] = [
        "Table 11 warning/order times are Incident Commander requests; the ECC ordered all of Paradise at 08:03.",
        "Table 11 first-fire times are first documented observations, not exact arrival.",
        "Zone polygons are missing, so zone events cannot be mapped and no zone population crosswalk exists.",
        "NIST Table 13 lists some burnover start times 5-15 min earlier than Table 30; Table 30 is used.",
        "TRA coordinates on private residential parcels (TRA-F, H, J, X) are rounded to 0.001 degree.",
        "TRA occupant counts are published ranges over the whole active period, not time series.",
        "Fire-observation dates are corrected from workbook 2021 serials to 2018 (derived); free text excluded.",
        "Fire-observation type codes are not expanded; consult NIST TN 2135.",
        "FIRMS points are pixel centres of thermal anomalies, not perimeters; type 2 static sources retained with label.",
    ]
    return quality


def build(base_package: Path, extracts_dir: Path, dem_dir: Path, output_root: Path) -> Path:
    files = add_layers(base_package, extracts_dir, dem_dir)
    version = json.loads(files["manifest.json"])["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    with tempfile.TemporaryDirectory(prefix="camp-layers-", dir=output_root) as temp_dir:
        temporary = Path(temp_dir)
        for name, data in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        shutil.move(str(temporary), str(target))
    return target


def verify(package: Path) -> dict:
    manifest = json.loads((package / "manifest.json").read_bytes())
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("layers_normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("layers package identity or version mismatch")
    files = {}
    for item in manifest["artifacts"]:
        data = (package / item["path"]).read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
        files[item["path"]] = data
    nodes, edges, exits, _ = normalize_roads(files["raw/osm-roads.json"])
    for name, expected in (("normalized/road_nodes.geojson", nodes), ("normalized/road_edges.geojson", edges),
                           ("normalized/exit_nodes.json", exits)):
        if files[name] != encoded_json(expected):
            raise SourceError(f"road normalization mismatch: {name}")
    layers, stats = normalized_layers(files)
    for name, data in layers.items():
        if files[name] != data:
            raise SourceError(f"offline normalization mismatch: {name}")
    new_inputs = {name: data for name, data in files.items()
                  if name in TABLES or name.startswith("raw/extracts/") or name.startswith(DEM_RAW_DIR)}
    if (package_version(manifest["parent_package_version"], new_inputs) != package.name
            or manifest["package_version"] != package.name):
        raise SourceError("layers package version mismatch")
    return {"package_version": package.name, "parent_package_version": manifest["parent_package_version"],
            **{name: layer.get("count") for name, layer in layer_status(stats).items()},
            "new_event_counts": stats["new_event_counts"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-package", type=Path)
    parser.add_argument("--extracts-dir", type=Path, help="output directory of tools.camp_extracts")
    parser.add_argument("--dem-dir", type=Path, help="output directory of tools.camp_terrain --fetch-to")
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
    elif args.base_package and args.extracts_dir and args.dem_dir:
        print(build(args.base_package, args.extracts_dir, args.dem_dir, args.output_root))
    else:
        parser.error("--base-package with --extracts-dir and --dem-dir, or --verify-package, is required")


if __name__ == "__main__":
    main()
