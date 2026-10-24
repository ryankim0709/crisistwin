"""Normalize the Zenodo Kincade PeMS workbook (DOI 10.5281/zenodo.7410114).

The workbook ``data_routine_evacuation.xlsx`` is parsed with ``zipfile`` and
``xml.etree`` only. It holds 5-minute US 101 detector aggregates for eight
routine weekend days (2019-09-28 .. 2019-10-20) and the evacuation weekend
(2019-10-26/27) at 24 anonymised locations (L1N..L12S).

Timestamps are Excel serial wall-clock values without a zone. PeMS exports
local Pacific time, and the data itself agrees: routine flow is lowest at
03:00 and the evacuation weekend peaks right after the 10:00 (Oct 26) and
04:30 (Oct 27) order times as written in the official matrix. The package
therefore converts them as America/Los_Angeles (PDT, UTC-7) and labels this
interpretation ``derived``.
"""

from __future__ import annotations

import csv
import io
import json
import math
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

from tools.kincade_common import SourceError, local_to_utc, utc_text

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
ZENODO_RECORD = "https://zenodo.org/records/7410114"
SOURCE_ID = "zenodo-7410114-kincade-pems"
STATION_SOURCE_ID = "rohaert-2023-trd-103610"
INTERVAL_S = 300
EXCEL_EPOCH = datetime(1899, 12, 30)
HEADER = (
    "Time", "Detector", "Scenario", "Detector health (%)",
    *(f"{lane} {m}" for lane in ("L1", "L2", "L3", "T") for m in (
        "Average vehicle length (m/veh)", "Density (veh/km/lane)", "Flow (veh/h/lane)",
        "Occupancy (-)", "Speed (km/h)", "Truck Flow (trucks/h/lane)")),
)
COLUMNS = (
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P",
    "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB",
)
SCENARIOS = {"Routine": "routine", "Evacuation": "evacuation"}
LANE_FLOW_COLUMNS = ("G", "M", "S")  # L1, L2, L3 flow (veh/h/lane)
# Columns kept in the packaged cell extract: time, detector, scenario, health,
# per-lane flows and the T (per-lane average) block. Other per-lane metrics stay
# only in the Zenodo workbook (DOI, SHA-256 recorded).
KEPT_COLUMNS = ("A", "B", "C", "D", "G", "M", "S", "W", "X", "Y", "Z", "AA", "AB")


def workbook_cells_csv(workbook: bytes) -> bytes:
    """Deterministic CSV of the Sheet1 columns in KEPT_COLUMNS (derived subset).

    Columns: source row number, then KEPT_COLUMNS. Shared strings are written
    as ``s:<text>``; numeric cells keep the exact ``<v>`` text from the XML.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(workbook))
        shared = [
            "".join(t.text or "" for t in si.iter(NS + "t"))
            for si in ET.fromstring(archive.read("xl/sharedStrings.xml")).iter(NS + "si")
        ]
        sheet = archive.open("xl/worksheets/sheet1.xml")
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise SourceError(f"workbook is not the expected xlsx: {exc}") from exc
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["row", *KEPT_COLUMNS])
    with sheet:
        for _, element in ET.iterparse(sheet):
            if element.tag != NS + "row":
                continue
            cells = dict.fromkeys(COLUMNS, "")
            for cell in element:
                column = "".join(ch for ch in cell.get("r", "") if ch.isalpha())
                value = cell.find(NS + "v")
                if value is None:
                    continue
                if column not in cells:
                    raise SourceError(f"unexpected column {column}")
                cells[column] = f"s:{shared[int(value.text)]}" if cell.get("t") == "s" else value.text
            if element.get("r") == "1" and tuple(cells[c][2:] for c in COLUMNS) != HEADER:
                raise SourceError("unexpected workbook header")
            writer.writerow([element.get("r"), *(cells[c] for c in KEPT_COLUMNS)])
            element.clear()
    return out.getvalue().encode()


def _csv_rows(cells_csv: bytes):
    reader = csv.reader(io.StringIO(cells_csv.decode("utf-8")))
    if next(reader) != ["row", *KEPT_COLUMNS]:
        raise SourceError("unexpected cell CSV header")
    for record in reader:
        values: dict[str, object] = {}
        for column, text in zip(KEPT_COLUMNS, record[1:]):
            if text == "":
                continue
            if text.startswith("s:"):
                values[column] = text[2:]
            else:
                number = float(text)
                if not math.isfinite(number):
                    raise SourceError(f"non-finite value in row {record[0]} column {column}")
                values[column] = number
        yield int(record[0]), values


def excel_local_time(serial: float) -> datetime:
    moment = EXCEL_EPOCH + timedelta(days=serial)
    rounded = (moment + timedelta(seconds=30)).replace(second=0, microsecond=0)
    if abs((moment - rounded).total_seconds()) > 1 or rounded.minute % 5:
        raise SourceError(f"timestamp {serial} is not on a 5-minute boundary")
    return rounded


def _num(values: dict, column: str) -> float | None:
    value = values.get(column)
    if value is None:
        return None
    if not isinstance(value, float):
        raise SourceError(f"column {column} is not numeric")
    return value


POSTMILE_URL = "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0"
POSTMILE_QUERY = {"where": "Route=101 AND Odometer>=470 AND Odometer<=501",
                  "outFields": "Route,County,PMPrefix,PM,PMSuffix,Odometer,AlignCode,Direction",
                  "outSR": "4326", "orderByFields": "Odometer", "resultRecordCount": "2000", "f": "json"}
POSTMILE_MATCH_TOLERANCE_MI = 0.07


def _postmile_lookup(postmile_bytes: bytes) -> dict[str, list[tuple[float, list[float], dict]]]:
    data = json.loads(postmile_bytes)
    if data.get("error") or data.get("exceededTransferLimit") or not data.get("features"):
        raise SourceError("Caltrans postmile response invalid or truncated")
    by_dir: dict[str, list] = {"N": [], "S": []}
    for f in data["features"]:
        a, g = f["attributes"], f["geometry"]
        if a["Route"] != 101 or a["Direction"] not in ("NB", "SB"):
            raise SourceError("unexpected postmile record")
        by_dir[a["Direction"][0]].append((a["Odometer"], [g["x"], g["y"]], a))
    return by_dir


def stations(table_bytes: bytes, postmile_bytes: bytes | None = None) -> dict:
    table = json.loads(table_bytes)
    lookup = _postmile_lookup(postmile_bytes) if postmile_bytes else None
    features = []
    for row in table["stations"]:
        geometry, match = None, None
        if lookup:
            odo, coord, attrs = min(lookup[row["direction"]], key=lambda c: abs(c[0] - row["milepost_mi"]))
            if abs(odo - row["milepost_mi"]) <= POSTMILE_MATCH_TOLERANCE_MI:
                geometry = {"type": "Point", "coordinates": coord}
                match = {"caltrans_odometer_mi": round(odo, 3), "county": attrs["County"],
                         "county_postmile": round(attrs["PM"], 1), "offset_mi": round(abs(odo - row["milepost_mi"]), 3)}
        features.append({
            "type": "Feature", "id": f"kincade-us101:{row['label']}",
            "geometry": geometry,
            "properties": {
                "station_id": f"kincade-us101:{row['label']}",
                "source_detector_label": row["label"],
                "pems_vds_id": None, "pems_vds_id_status": "unknown",
                "pems_vds_id_reason": "the Zenodo dataset anonymises locations; the paper lists mileposts only",
                "route": table["route"],
                "direction": {"N": "northbound", "S": "southbound"}[row["direction"]],
                "postmile": row["milepost_mi"], "postmile_kind": "absolute (as printed in source Table 6)",
                "lanes": None, "lanes_status": "unknown",
                "lanes_reason": "paper states two or three mainline lanes; per-station count not published (see lanes_reporting in observations)",
                "type": "mainline dual loop (VDS)",
                "on_temporarily_closed_segment": row["closure_segment"],
                "location_status": "derived_nearest_postmile_point" if geometry else "unknown",
                "location_method": ("derived: nearest Caltrans SHN tenth-mile postmile point (same direction) whose "
                                    "Odometer is within 0.07 mi of the printed absolute postmile; assumes PeMS absolute "
                                    "postmile equals Caltrans odometer (not verified against PeMS metadata); no interpolation")
                if geometry else "no PeMS station metadata access",
                "location_match": match,
                "geometry_evidence_class": "derived" if geometry else None,
                "evidence_class": "reported", "source_id": STATION_SOURCE_ID,
                "source_locator": table["source_locator"],
            },
        })
    return {"type": "FeatureCollection", "features": features}


def normalize_traffic(cells_csv: bytes, station_table: bytes) -> tuple[list[dict], dict]:
    known = {f["properties"]["source_detector_label"] for f in stations(station_table)["features"]}
    observations = []
    seen = set()
    health_zero = 0
    for row_number, values in _csv_rows(cells_csv):
        if row_number == 1:
            header = tuple(values.get(c) for c in KEPT_COLUMNS)
            if header != tuple(HEADER[COLUMNS.index(c)] for c in KEPT_COLUMNS):
                raise SourceError(f"unexpected workbook header: {header}")
            continue
        label, scenario = values.get("B"), values.get("C")
        if label not in known or scenario not in SCENARIOS or not isinstance(values.get("A"), float):
            raise SourceError(f"row {row_number}: unexpected detector, scenario or time")
        local = excel_local_time(values["A"])
        key = (label, local)
        if key in seen:
            raise SourceError(f"row {row_number}: duplicate detector interval")
        seen.add(key)
        start = local_to_utc(local)
        lane_flows = [_num(values, c) for c in LANE_FLOW_COLUMNS]
        present = [f for f in lane_flows if f is not None]
        if any(f < 0 for f in present):
            raise SourceError(f"row {row_number}: negative flow")
        health = _num(values, "D")
        if health is not None and health == 0:
            health_zero += 1
        occupancy = _num(values, "Z")
        observations.append({
            "station_id": f"kincade-us101:{label}",
            "interval_start": utc_text(start),
            "interval_s": INTERVAL_S,
            "interval_start_local_as_written": local.strftime("%Y-%m-%d %H:%M"),
            "local_time_basis": "America/Los_Angeles (PDT) inferred; source states no zone",
            "scenario": SCENARIOS[scenario],
            "flow_veh": round(sum(present) * INTERVAL_S / 3600, 6) if present else None,
            "flow_veh_per_h_per_lane": _num(values, "Y"),
            "speed_kph": _num(values, "AA"),
            "occupancy_pct": round(occupancy * 100, 6) if occupancy is not None else None,
            "density_veh_per_km_per_lane": _num(values, "X"),
            "avg_vehicle_length_m": _num(values, "W"),
            "truck_flow_per_h_per_lane": _num(values, "AB"),
            "lanes_reporting": len(present),
            "detector_health_pct": health,
            "pct_observed": None, "pct_observed_status": "unknown",
            "evidence_class": "observed",
            "derived_fields": ["flow_veh", "occupancy_pct", "interval_start"],
            "source_id": SOURCE_ID,
            "source_locator": f"{ZENODO_RECORD} data_routine_evacuation.xlsx Sheet1 row {row_number}",
        })
    observations.sort(key=lambda o: (o["interval_start"], o["station_id"]))
    by_scenario: dict[str, list[str]] = {}
    for o in observations:
        by_scenario.setdefault(o["scenario"], []).append(o["interval_start"])
    quality = {
        "observation_count": len(observations),
        "station_count": len({o["station_id"] for o in observations}),
        "detector_health_zero_count": health_zero,
        "scenario_time_coverage_utc": {k: [min(v), max(v)] for k, v in sorted(by_scenario.items())},
        "notes": [
            "Workbook times are wall-clock local; converted with PDT (UTC-7), inferred from diurnal minimum and order-time peaks.",
            "flow_veh = sum of per-lane hourly rates x 300/3600 (derived); per-lane rates are kept only in the raw workbook.",
            "T columns are the workbook's per-lane averages; density and vehicle length were computed by the dataset authors.",
            "pct_observed (PeMS imputation share) is not in the dataset; detector_health_pct is the dataset's health field.",
            "Station points are derived from Caltrans SHN postmile points by matching printed absolute postmile to Caltrans odometer (assumed equivalent).",
            "Routine days are weekend days only (Sat/Sun of ISO weeks 39-42), matching the paper's design.",
        ],
    }
    return observations, quality
