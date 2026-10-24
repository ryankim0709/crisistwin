"""Add reviewed NIST CodeRED alert rows to a frozen Camp evacuation package.

The complete NIST supplement includes individual 911 details and is intentionally
not bundled. The non-identifying Table D-1 transcription is frozen instead.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from tools.build_camp_evacuation import (
    INCIDENT_ID,
    SourceError,
    artifact,
    encoded_json,
    normalize_roads,
    sha256,
    verify as verify_roads,
)


NORMALIZER_VERSION = "codedred-1"
TABLE_PATH = Path(__file__).with_name("camp_codedred_table.json")
SOURCE_URL = "https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252sup.pdf"


def parse_local_time(date_text: str, clock_text: str, zone: ZoneInfo) -> datetime:
    match = re.fullmatch(r"(\d{2}):(\d{2})", clock_text)
    if not match:
        raise SourceError(f"invalid CodeRED local time {clock_text!r}")
    hour, minute = map(int, match.groups())
    if not 0 <= hour <= 47 or not 0 <= minute < 60:
        raise SourceError(f"invalid CodeRED local time {clock_text!r}")
    start = datetime.fromisoformat(date_text).replace(tzinfo=zone)
    return start + timedelta(hours=hour, minutes=minute)


def utc_text(value: datetime) -> str:
    return value.astimezone(ZoneInfo("UTC")).isoformat(timespec="seconds").replace("+00:00", "Z")


def target_for(label: str) -> dict:
    if re.fullmatch(r"\d{1,2}(?:, \d{1,2})*", label):
        return {"zone_ids": [f"paradise-2017-zone-{part}" for part in label.split(", ")]}
    return {"place_name": label}


def normalize_events(table_bytes: bytes) -> list[dict]:
    try:
        table = json.loads(table_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"invalid curated CodeRED table: {exc}") from exc
    if (table.get("source_id") != "nist-nettra-supplement"
            or table.get("source_url") != SOURCE_URL
            or table.get("table") != "D-1"
            or table.get("incident_local_date") != "2018-11-08"
            or table.get("time_zone") != "America/Los_Angeles"
            or not re.fullmatch(r"[0-9a-f]{64}", table.get("source_sha256", ""))
            or not isinstance(table.get("rows"), list)):
        raise SourceError("curated CodeRED table has invalid identity or metadata")
    zone = ZoneInfo(table["time_zone"])
    events = []
    previous = None
    for index, row in enumerate(table["rows"], 1):
        if (not isinstance(row, dict)
                or set(row) != {"initial_time", "evacuation_type", "zones_as_written", "recall_time", "page"}
                or row["evacuation_type"] not in ("Order", "Warning")
                or row["page"] not in ("D-3", "D-4")
                or not isinstance(row["zones_as_written"], str)
                or not row["zones_as_written"]):
            raise SourceError(f"invalid CodeRED table row {index}")
        initial = parse_local_time(table["incident_local_date"], row["initial_time"], zone)
        if previous and initial <= previous:
            raise SourceError("CodeRED initial times are not strictly ordered")
        previous = initial
        for attempt_kind, time_text in (("initial", row["initial_time"]), ("recall", row["recall_time"])):
            if time_text is None:
                continue
            local_time = parse_local_time(table["incident_local_date"], time_text, zone)
            if local_time < initial:
                raise SourceError(f"CodeRED re-call precedes initial message in row {index}")
            occurred_at = utc_text(local_time)
            status = row["evacuation_type"].lower()
            events.append({
                "event_id": f"nist-codedred:{index:02d}:{attempt_kind}",
                "type": "alert_sent",
                "occurred_at": occurred_at,
                "occurred_from": occurred_at,
                "occurred_to": utc_text(local_time + timedelta(minutes=1)),
                "time_precision": "minute",
                "available_at": None,
                "available_at_status": "unknown",
                "available_at_reason": "individual delivery and responder availability not established by Table D-1",
                "local_time_as_written": f"11/8 {time_text}",
                "target": target_for(row["zones_as_written"]),
                "geometry": None,
                "geocode_method": "unresolved",
                "description": f"CodeRED {status} message {attempt_kind} attempt for {row['zones_as_written']}.",
                "quote": None,
                "alert_system": "CodeRED",
                "alert_attempt": attempt_kind,
                "evacuation_status_in_message": status,
                "evidence_class": "reconstructed",
                "source_id": "nist-nettra-supplement",
                "source_locator": f"{SOURCE_URL}#page={135 if row['page'] == 'D-3' else 136}; Table D-1; p. {row['page']}; row {index}",
            })
    events.sort(key=lambda event: (event["occurred_at"], event["event_id"]))
    return events


def add_events(base_package: Path, table_bytes: bytes) -> dict[str, bytes]:
    verify_roads(base_package)
    base_manifest = json.loads((base_package / "manifest.json").read_bytes())
    files = {item["path"]: (base_package / item["path"]).read_bytes()
             for item in base_manifest["artifacts"]}
    events = normalize_events(table_bytes)
    files["curated/nist-codedred-table.json"] = table_bytes
    files["normalized/events.jsonl"] = b"".join(encoded_json(event) for event in events)
    sources = json.loads(files["sources.json"])
    table = json.loads(table_bytes)
    sources["nist-nettra-supplement"] = {
        "provider": "National Institute of Standards and Technology",
        "landing_url": SOURCE_URL,
        "source_sha256": table["source_sha256"],
        "source_locator": "Table D-1, pp. D-3–D-4",
        "license": "NIST open license",
        "license_url": "https://www.nist.gov/open/license",
        "attribution": "NIST Technical Note 2252 Supplement (2023), Table D-1",
        "raw_source_status": "not bundled: full supplement contains individual 911 and address details",
        "curated_path": "curated/nist-codedred-table.json",
    }
    files["sources.json"] = encoded_json(sources)
    quality = json.loads(files["quality.json"])
    quality["codedred_table_rows"] = len(table["rows"])
    quality["alert_event_count"] = len(events)
    quality["event_limitations"] = [
        "CodeRED initiation and re-call times are not evacuation-order request times.",
        "The source does not prove each resident received a message or departed.",
        "Named zones and places remain ungeocoded until 2017 zone polygons are acquired.",
        "The event layer is partial: road access and other alerts are not yet included.",
    ]
    files["quality.json"] = encoded_json(quality)
    manifest = copy.deepcopy(base_manifest)
    manifest["parent_package_version"] = base_manifest["package_version"]
    manifest["event_normalizer_version"] = NORMALIZER_VERSION
    manifest["package_version"] = sha256(
        base_manifest["package_version"].encode() + table_bytes + NORMALIZER_VERSION.encode()
    )[:16]
    manifest["layers"]["events"] = {
        "status": "partial", "count": len(events),
        "event_type": "alert_sent",
        "time_coverage_utc": [events[0]["occurred_at"], events[-1]["occurred_at"]],
        "coverage": "NIST Table D-1 CodeRED initial and re-call attempts only",
        "missing": "order request times, road closures, fire arrivals, shelter events and other alerts",
    }
    manifest["artifacts"] = [
        artifact(path, data, len(events) if path == "normalized/events.jsonl" else None)
        for path, data in sorted(files.items())
    ]
    files["manifest.json"] = encoded_json(manifest)
    return files


def build(base_package: Path, output_root: Path) -> Path:
    table_bytes = TABLE_PATH.read_bytes()
    files = add_events(base_package, table_bytes)
    version = json.loads(files["manifest.json"])["package_version"]
    target = output_root / INCIDENT_ID / version
    if target.exists():
        raise SourceError(f"immutable package already exists: {target}")
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="camp-events-", dir=output_root) as temp_dir:
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
    if manifest.get("incident_id") != INCIDENT_ID or manifest.get("event_normalizer_version") != NORMALIZER_VERSION:
        raise SourceError("event package identity or version mismatch")
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
    table_bytes = (package / "curated/nist-codedred-table.json").read_bytes()
    events = normalize_events(table_bytes)
    if (package / "normalized/events.jsonl").read_bytes() != b"".join(encoded_json(event) for event in events):
        raise SourceError("event normalization mismatch")
    expected_version = sha256(
        manifest["parent_package_version"].encode() + table_bytes + NORMALIZER_VERSION.encode()
    )[:16]
    if package.name != manifest["package_version"] or expected_version != package.name:
        raise SourceError("event package version mismatch")
    return {"event_count": len(events), "table_rows": len(json.loads(table_bytes)["rows"])}


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
