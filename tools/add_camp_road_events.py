"""Add reviewed NIST road observations to the frozen Camp evacuation package."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.add_camp_codedred import normalize_events as normalize_codedred
from tools.build_camp_evacuation import (
    INCIDENT_ID,
    SourceError,
    artifact,
    encoded_json,
    normalize_roads,
    sha256,
)


NORMALIZER_VERSION = "road-events-1"
TABLE_PATH = Path(__file__).with_name("camp_road_events_table.json")
SOURCE_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf"
EVENT_TYPES = {
    "soft_closure": "road_access_restricted",
    "hard_closure": "road_closed",
    "contraflow_announcement": "contraflow_reported",
    "contraflow_active": "contraflow_observed",
    "contraflow_start_report": "contraflow_reported",
    "road_blockage": "road_blocked",
    "fire_blockage": "road_blocked",
    "vehicle_blockage": "road_blocked",
    "utility_blockage": "road_blocked",
}


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_road_events(table_bytes: bytes) -> list[dict]:
    try:
        table = json.loads(table_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"invalid curated road-event table: {exc}") from exc
    if (table.get("source_url") != SOURCE_URL
            or table.get("time_zone") != "America/Los_Angeles"
            or not re.fullmatch(r"[0-9a-f]{64}", table.get("source_sha256", ""))
            or not isinstance(table.get("events"), list)):
        raise SourceError("road-event table has invalid source metadata")
    events = []
    seen = set()
    for row in table["events"]:
        if not isinstance(row, dict):
            raise SourceError("road-event row is not an object")
        record_id = row.get("id")
        kind = row.get("event_kind")
        if not isinstance(record_id, str) or record_id in seen or kind not in EVENT_TYPES:
            raise SourceError(f"invalid or duplicate road-event ID/type: {record_id}")
        seen.add(record_id)
        page_label, pdf_page = row.get("printed_page"), row.get("pdf_page")
        if (not isinstance(page_label, str) or not re.fullmatch(r"A-[0-9]+", page_label)
                or type(pdf_page) is not int or pdf_page <= 0):
            raise SourceError(f"invalid source page for {record_id}")
        try:
            local_time = datetime.fromisoformat(row["reported_time_local"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SourceError(f"invalid local time for {record_id}") from exc
        if (local_time.tzinfo is None or local_time.utcoffset() != timedelta(hours=-8)
                or local_time.date().isoformat() != "2018-11-08"):
            raise SourceError(f"unexpected date or offset for {record_id}")
        window_min = row.get("observation_window_min")
        if type(window_min) is not int or not 0 <= window_min <= 1440:
            raise SourceError(f"invalid observation window for {record_id}")
        coords = row.get("point_lon_lat")
        if coords is not None:
            if (not isinstance(coords, list) or len(coords) != 2
                    or any(type(x) not in (int, float) or not math.isfinite(x) for x in coords)
                    or not (-180 <= coords[0] <= 180 and -90 <= coords[1] <= 90)):
                raise SourceError(f"invalid source point for {record_id}")
        road_label = row.get("road_location_as_written")
        observation = row.get("source_observation")
        if not isinstance(road_label, str) or not road_label or not isinstance(observation, str) or not observation:
            raise SourceError(f"missing road description for {record_id}")
        occurred_at = utc_text(local_time)
        event = {
            "event_id": record_id,
            "type": EVENT_TYPES[kind],
            "occurred_at": occurred_at,
            "occurred_from": occurred_at,
            "occurred_to": utc_text(local_time + timedelta(minutes=window_min or 1)),
            "time_precision": "approximate" if window_min else "minute",
            "time_role": "observation_or_report_time; road-state onset may be earlier or unknown",
            "observation_window_min": window_min,
            "available_at": None,
            "available_at_status": "unknown",
            "available_at_reason": "retrospective source does not establish public or responder availability",
            "local_time_as_written": f"11/8 {local_time.strftime('%H:%M')}",
            "target": {
                "osm_way_ids": None, "osm_way_ids_status": "unresolved",
                "road_name": road_label, "from_desc": None, "to_desc": None,
            },
            "geometry": {"type": "Point", "coordinates": coords} if coords else None,
            "geocode_method": "source_observation_point_unsnapped" if coords else "unresolved",
            "description": observation,
            "quote": None,
            "action_status": row.get("action_status"),
            "source_time_method": row.get("time_source"),
            "source_number": row.get("source_number"),
            "evidence_class": row.get("classification"),
            "source_id": "nist-nettra-supplement",
            "source_locator": f"{SOURCE_URL}#page={pdf_page}; Table A-2; p. {page_label}; source {row.get('source_number')}",
        }
        if event["evidence_class"] not in ("reported", "reconstructed"):
            raise SourceError(f"invalid evidence class for {record_id}")
        events.append(event)
    events.sort(key=lambda event: (event["occurred_at"], event["event_id"]))
    return events


def add_events(base_package: Path, table_bytes: bytes) -> dict[str, bytes]:
    from tools.add_camp_codedred import verify as verify_codedred

    verify_codedred(base_package)
    base_manifest = json.loads((base_package / "manifest.json").read_bytes())
    files = {item["path"]: (base_package / item["path"]).read_bytes()
             for item in base_manifest["artifacts"]}
    files["curated/nist-road-events-table.json"] = table_bytes
    codedred_events = normalize_codedred(files["curated/nist-codedred-table.json"])
    road_events = normalize_road_events(table_bytes)
    events = sorted(codedred_events + road_events, key=lambda event: (event["occurred_at"], event["event_id"]))
    files["normalized/events.jsonl"] = b"".join(encoded_json(event) for event in events)
    quality = json.loads(files["quality.json"])
    quality["road_event_observation_count"] = len(road_events)
    quality["event_count"] = len(events)
    quality["road_event_limitations"] = [
        "Table A-2 points are observation locations, not OSM edge matches.",
        "Reported road state at an observation time does not establish exact closure onset.",
        "The 09:20 contraflow report describes initiation, not active contraflow on all routes.",
        "No road reopening times were verified in this acquisition layer.",
    ]
    files["quality.json"] = encoded_json(quality)
    manifest = copy.deepcopy(base_manifest)
    manifest["parent_package_version"] = base_manifest["package_version"]
    manifest["road_event_normalizer_version"] = NORMALIZER_VERSION
    manifest["package_version"] = sha256(
        base_manifest["package_version"].encode() + table_bytes + NORMALIZER_VERSION.encode()
    )[:16]
    manifest["layers"]["events"] = {
        "status": "partial", "count": len(events),
        "time_coverage_utc": [events[0]["occurred_at"], events[-1]["occurred_at"]],
        "coverage": "29 CodeRED rows and 12 reviewed NIST road observations",
        "missing": "most NETTRA observations, order requests, fire arrivals, shelters and known reopening times",
    }
    manifest["artifacts"] = [
        artifact(path, data, len(events) if path == "normalized/events.jsonl" else None)
        for path, data in sorted(files.items())
    ]
    files["manifest.json"] = encoded_json(manifest)
    return files


def build(base_package: Path, output_root: Path) -> Path:
    files = add_events(base_package, TABLE_PATH.read_bytes())
    version = json.loads(files["manifest.json"])["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="camp-road-events-", dir=output_root) as temp_dir:
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
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("road_event_normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("road-event package identity or version mismatch")
    for item in manifest["artifacts"]:
        data = (package / item["path"]).read_bytes()
        if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
            raise SourceError(f"artifact checksum mismatch: {item['path']}")
    raw = (package / "raw/osm-roads.json").read_bytes()
    nodes, edges, exits, _ = normalize_roads(raw)
    for name, expected in (
        ("normalized/road_nodes.geojson", nodes),
        ("normalized/road_edges.geojson", edges),
        ("normalized/exit_nodes.json", exits),
    ):
        if (package / name).read_bytes() != encoded_json(expected):
            raise SourceError(f"road normalization mismatch: {name}")
    table_bytes = (package / "curated/nist-road-events-table.json").read_bytes()
    codedred_events = normalize_codedred((package / "curated/nist-codedred-table.json").read_bytes())
    road_events = normalize_road_events(table_bytes)
    events = sorted(codedred_events + road_events, key=lambda event: (event["occurred_at"], event["event_id"]))
    if (package / "normalized/events.jsonl").read_bytes() != b"".join(encoded_json(event) for event in events):
        raise SourceError("combined event normalization mismatch")
    expected_version = sha256(
        manifest["parent_package_version"].encode() + table_bytes + NORMALIZER_VERSION.encode()
    )[:16]
    if expected_version != package.name or manifest["package_version"] != package.name:
        raise SourceError("road-event package version mismatch")
    return {"event_count": len(events), "road_event_count": len(road_events)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-package", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--verify-package", type=Path)
    args = parser.parse_args()
    if args.verify_package:
        print(json.dumps(verify(args.verify_package), indent=2))
    elif args.base_package:
        print(build(args.base_package, args.output_root))
    else:
        parser.error("--base-package or --verify-package is required")


if __name__ == "__main__":
    main()
