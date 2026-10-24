"""Export one retrospective Camp Fire perimeter frame from the frozen package."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from tools.build_camp_history import SourceError, canonical_json, verify_package


def parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SourceError(f"invalid timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise SourceError("replay timestamp needs a UTC offset or Z")
    return parsed.astimezone(timezone.utc)


def frame_at(package: Path, at: datetime) -> dict:
    if at.tzinfo is None:
        raise SourceError("replay time must include a timezone")
    manifest = verify_package(package)
    observations = json.loads((package / "normalized/fire_perimeters.geojson").read_text())["features"]
    at_utc = at.astimezone(timezone.utc)
    selected = None
    for feature in observations:
        observation_at = parse_utc(feature["properties"]["snapshot_at"])
        if observation_at > at_utc:
            break
        selected = feature
    first = parse_utc(manifest["layers"]["fire_perimeters"]["first_snapshot_at"])
    last = parse_utc(manifest["layers"]["fire_perimeters"]["last_snapshot_at"])
    coverage = ("before_first_observation" if at_utc < first
                else "after_last_observation" if at_utc > last
                else "within_observation_window")
    selected_at = parse_utc(selected["properties"]["snapshot_at"]) if selected else None
    return {
        "type": "FeatureCollection",
        "features": [selected] if selected else [],
        "replay": {
            "mode": "retrospective",
            "incident_id": manifest["incident_id"],
            "package_version": manifest["package_version"],
            "requested_at": at_utc.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "snapshot_at": selected["properties"]["snapshot_at"] if selected else None,
            "snapshot_age_seconds": int((at_utc - selected_at).total_seconds()) if selected_at else None,
            "coverage": coverage,
            "interpolation": "none",
            "perimeter_kind": "satellite_derived_cumulative_estimate",
            "source_availability": "unknown",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--at", required=True, help="ISO 8601 time with Z or UTC offset")
    parser.add_argument("--output", type=Path, required=True, help="GeoJSON frame to write")
    args = parser.parse_args()
    try:
        frame = frame_at(args.package, parse_utc(args.at))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json(frame))
    except (OSError, SourceError, json.JSONDecodeError) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"{args.output}: {frame['replay']['coverage']}, snapshot {frame['replay']['snapshot_at']}")


if __name__ == "__main__":
    main()
