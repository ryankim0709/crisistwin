"""Historical bridge: planner-confirmed incident-intel candidates -> events.jsonl rows for sim.variants.

Input is the saved body of `GET /api/intel/candidates` (the `{"candidates": [...]}` object or
a bare list). Only rows with `review_status: "confirmed"` and `evidence_class: "reported"` are
accepted; anything else refuses the whole export. Rows keep exactly the package events.jsonl
keys; the planner's `mapping.road_name` and `mapping.point` replace `target.road_name` and
`geometry`, because coordinates come only from a planner, never from page text or a model.
Contract: docs/incident-intel.md, section (d).

Run from the repository root:
  python3 -m sim.intel export --candidates /tmp/camp-intel.json --output /tmp/camp-intel-events.jsonl
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

from tools.build_camp_evacuation import encoded_json
from tools.build_camp_history import SourceError

from sim.history import parse_utc

ROAD_INTEL_TYPES = ("road_closed", "road_blocked", "road_access_restricted", "road_reopened", "contraflow_reported")
INTEL_TYPES = ROAD_INTEL_TYPES + (
    "evacuation_order", "evacuation_warning", "alert_sent", "shelter_opened", "shelter_full", "shelter_closed",
)
PACKAGE_KEYS = (
    "event_id", "type", "occurred_at", "occurred_from", "occurred_to", "time_precision", "time_role",
    "observation_window_min", "available_at", "available_at_status", "available_at_reason", "local_time_as_written",
    "target", "geometry", "geocode_method", "description", "quote", "action_status", "source_time_method",
    "source_number", "evidence_class", "source_id", "source_locator",
)
_EVENT_ID = re.compile(r"^intel-[0-9a-f]{16}$")


def _point(value) -> list[float] | None:
    """[lon, lat] as finite floats in WGS84 range, else None."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        return None
    lon, lat = float(value[0]), float(value[1])
    return [lon, lat] if -180 <= lon <= 180 and -90 <= lat <= 90 else None


def _check_times(row: dict, where: str) -> None:
    for key in ("occurred_at", "available_at"):
        if not isinstance(row.get(key), str):
            raise SourceError(f"{where}: {key} must be a UTC timestamp")
        parse_utc(row[key])
    for key in ("occurred_from", "occurred_to"):
        if row.get(key) is not None:
            parse_utc(row[key])


def export_rows(candidates) -> list[dict]:
    """Confirmed reported candidates as events.jsonl rows, sorted by (occurred_at, event_id). Raises SourceError."""
    if isinstance(candidates, dict):
        candidates = candidates.get("candidates")
    if not isinstance(candidates, list):
        raise SourceError("expected a GET /api/intel/candidates body or a list of candidates")
    rows, seen = [], set()
    for i, c in enumerate(candidates):
        if not isinstance(c, dict):
            raise SourceError(f"candidate {i}: not an object")
        where = f"candidate {i} ({c.get('event_id')})"
        if not isinstance(c.get("event_id"), str) or not _EVENT_ID.match(c["event_id"]):
            raise SourceError(f"{where}: event_id must be intel-<16 hex>")
        if c["event_id"] in seen:
            raise SourceError(f"{where}: duplicate event_id")
        seen.add(c["event_id"])
        if c.get("review_status") != "confirmed":
            raise SourceError(f"{where}: review_status is {c.get('review_status')!r}; only confirmed rows export")
        if c.get("evidence_class") != "reported":
            raise SourceError(f"{where}: evidence_class is {c.get('evidence_class')!r}; expected 'reported'")
        if c.get("type") not in INTEL_TYPES:
            raise SourceError(f"{where}: type {c.get('type')!r} is not an incident-intel type")
        missing = [k for k in PACKAGE_KEYS if k not in c]
        if missing:
            raise SourceError(f"{where}: missing {', '.join(missing)}")
        _check_times(c, where)
        row = {k: c[k] for k in PACKAGE_KEYS}
        mapping = c.get("mapping") if isinstance(c.get("mapping"), dict) else {}
        point = _point(mapping.get("point"))
        if mapping.get("point") is not None and point is None:
            raise SourceError(f"{where}: mapping.point must be finite [lon, lat]")
        if c["type"] in ROAD_INTEL_TYPES:
            target = c["target"] if isinstance(c["target"], dict) else {}
            road_name = mapping.get("road_name") or target.get("road_name")
            if point is None:
                raise SourceError(f"{where}: road type needs a planner mapping.point")
            if not isinstance(road_name, str) or not road_name.strip():
                raise SourceError(f"{where}: road type needs a road name (mapping.road_name)")
            row["target"] = {**target, "road_name": road_name.strip()}
        if point is not None:
            row["geometry"] = {"type": "Point", "coordinates": point}
            row["geocode_method"] = "planner_mapped"
        rows.append(row)
    rows.sort(key=lambda r: (parse_utc(r["occurred_at"]), r["event_id"]))
    return rows


def load_intel_rows(path: Path) -> list[dict]:
    """Rows of an exported intel events.jsonl. Raises SourceError unless each row has exactly the export's shape."""
    rows = []
    for n, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SourceError(f"{path}:{n}: invalid JSON: {exc}") from exc
        if not isinstance(row, dict) or set(row) != set(PACKAGE_KEYS):
            raise SourceError(f"{path}:{n}: not a `sim.intel export` row")
        if row["evidence_class"] != "reported" or row["type"] not in INTEL_TYPES:
            raise SourceError(f"{path}:{n}: expected a reported incident-intel event")
        _check_times(row, f"{path}:{n}")
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(prog="python3 -m sim.intel", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export", help="write confirmed candidates as events.jsonl rows")
    export.add_argument("--candidates", type=Path, required=True,
                        help="saved JSON body of GET /api/intel/candidates (object or bare list)")
    export.add_argument("--output", type=Path, required=True, help="events.jsonl to write")
    args = parser.parse_args()
    try:
        rows = export_rows(json.loads(args.candidates.read_text()))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(b"".join(encoded_json(row) for row in rows))
    except (OSError, ValueError) as exc:  # SourceError and JSONDecodeError are ValueErrors
        parser.exit(1, f"error: {exc}\n")
    print(f"{args.output}: {len(rows)} confirmed reported events")


if __name__ == "__main__":
    main()
