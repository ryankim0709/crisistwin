"""Acquire a bounded Camp Fire package with damage and perimeter observations.

Uses only Python's standard library and curl. Original source responses and
normalized GeoJSON files are retained together in an immutable package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo


LAYER_URL = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/"
    "POSTFIRE_MASTER_DATA_SHARE/FeatureServer/0"
)
FEDS_URL = "https://openveda.cloud/api/features/collections/public.eis_fire_lf_perimeter_archive/items"
FEDS_FIRE_ID = "F17028"  # VEDA's documented Camp Fire identifier, scoped to 2018
FEDS_WINDOW = "2018-11-01T00:00:00Z/2018-12-01T00:00:00Z"
INCIDENT_ID = "camp-2018-paradise-slice"
INCIDENT_NAME = "Camp"
INCIDENT_NUMBER = "CABTU 016737"
BBOX = (-121.64, 39.73, -121.63, 39.74)  # W, S, E, N in OGC:CRS84 degrees
FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "DAMAGE",
    "INCIDENTNAME",
    "INCIDENTNUM",
    "INCIDENTSTARTDATE",
    "STRUCTURECATEGORY",
)
SCHEMA_VERSION = "0.2.2"
NORMALIZER_VERSION = "4"
PAGE_SIZE = 100


class SourceError(ValueError):
    """The provider response cannot form a trustworthy incident package."""


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode(
        "utf-8"
    )


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(data: bytes, label: str) -> dict:
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"{label}: invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SourceError(f"{label}: expected a JSON object")
    if "error" in value:
        raise SourceError(f"{label}: ArcGIS error: {value['error']}")
    return value


def request_json(base_url: str, path: str, params: dict[str, str]) -> bytes:
    # Both endpoints are fixed; command arguments never pass through a shell.
    if base_url not in (LAYER_URL, FEDS_URL):
        raise SourceError("unapproved data endpoint")
    url = f"{base_url}{path}?{urlencode(params)}"
    result = subprocess.run(
        [
            "curl", "--http1.1", "--silent", "--show-error", "--fail",
            "--location", "--retry", "2", "--retry-all-errors",
            "--retry-delay", "1", "--max-time", "60", url,
        ],
        capture_output=True,
        check=False,
        timeout=190,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise SourceError(f"CAL FIRE request failed ({result.returncode}): {message}")
    read_json(result.stdout, path)
    return result.stdout


def common_query() -> dict[str, str]:
    return {
        "where": f"INCIDENTNAME='{INCIDENT_NAME}' AND INCIDENTNUM='{INCIDENT_NUMBER}'",
        "geometry": ",".join(str(n) for n in BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "f": "json",
    }


def validate_ids(response: dict) -> list[int]:
    ids = response.get("objectIds")
    if not isinstance(ids, list) or not ids:
        raise SourceError("ID query returned no object IDs for the configured slice")
    if any(type(item) is not int or item < 0 for item in ids):
        raise SourceError("ID query contains invalid object IDs")
    if len(set(ids)) != len(ids):
        raise SourceError("ID query contains duplicate object IDs")
    return sorted(ids)


def utc_date_from_epoch_millis(value: object, label: str) -> str | None:
    if value is None:
        return None
    if type(value) is not int:
        raise SourceError(f"{label}: expected epoch milliseconds")
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
    except (OverflowError, OSError, ValueError) as exc:
        raise SourceError(f"{label}: invalid timestamp") from exc


def normalize_feature(feature: dict) -> dict:
    if not isinstance(feature, dict):
        raise SourceError("feature is not an object")
    attributes = feature.get("attributes")
    geometry = feature.get("geometry")
    if not isinstance(attributes, dict) or not isinstance(geometry, dict):
        raise SourceError("feature lacks attributes or point geometry")
    missing = set(FIELDS) - attributes.keys()
    if missing:
        raise SourceError(f"feature is missing fields: {sorted(missing)}")
    oid = attributes["OBJECTID"]
    global_id = attributes["GLOBALID"]
    if type(oid) is not int or oid < 0 or not isinstance(global_id, str) or not global_id:
        raise SourceError("feature has an invalid object ID or global ID")
    if attributes["INCIDENTNAME"] != INCIDENT_NAME or attributes["INCIDENTNUM"] != INCIDENT_NUMBER:
        raise SourceError(f"feature {oid}: unexpected incident identity")
    lon, lat = geometry.get("x"), geometry.get("y")
    if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
        raise SourceError(f"feature {oid}: invalid point coordinates")
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise SourceError(f"feature {oid}: point lies outside valid longitude/latitude bounds")
    for field in ("DAMAGE", "STRUCTURECATEGORY"):
        if attributes[field] is not None and not isinstance(attributes[field], str):
            raise SourceError(f"feature {oid}: invalid {field}")
    return {
        "type": "Feature",
        "id": f"calfire-dins:{global_id.lower()}",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "source_id": "calfire-dins",
            "source_object_id": oid,
            "source_global_id": global_id,
            "incident_id": INCIDENT_ID,
            "incident_start_date": utc_date_from_epoch_millis(attributes["INCIDENTSTARTDATE"], "incident start"),
            "assessment_at": None,
            "evidence_class": "observed",
            "temporal_role": "postfire_assessment",
            "damage": attributes["DAMAGE"],
            "structure_category": attributes["STRUCTURECATEGORY"],
            "location_role": "inspection_point",
            "outside_requested_bbox": not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]),
        },
    }


def normalize_pages(ids: list[int], pages: list[dict]) -> dict:
    wanted = set(ids)
    found: dict[int, dict] = {}
    globals_seen: set[str] = set()
    for index, page in enumerate(pages, 1):
        if page.get("spatialReference", {}).get("wkid") != 4326:
            raise SourceError(f"page {index}: expected WGS84 coordinates")
        if page.get("exceededTransferLimit"):
            raise SourceError(f"page {index}: ArcGIS transfer limit exceeded")
        features = page.get("features")
        if not isinstance(features, list):
            raise SourceError(f"page {index}: missing features array")
        for feature in features:
            normalized = normalize_feature(feature)
            oid = normalized["properties"]["source_object_id"]
            global_id = normalized["properties"]["source_global_id"].lower()
            if oid not in wanted or oid in found or global_id in globals_seen:
                raise SourceError(f"page {index}: unexpected or duplicate feature {oid}")
            found[oid] = normalized
            globals_seen.add(global_id)
    missing = wanted - found.keys()
    if missing:
        raise SourceError(f"missing {len(missing)} requested features; first: {min(missing)}")
    ordered = [found[oid] for oid in ids]
    coords = [feature["geometry"]["coordinates"] for feature in ordered]
    return {
        "type": "FeatureCollection",
        "bbox": [min(x for x, _ in coords), min(y for _, y in coords),
                 max(x for x, _ in coords), max(y for _, y in coords)],
        "features": ordered,
    }


def fire_query() -> dict[str, str]:
    return {
        "filter": f"fireid = '{FEDS_FIRE_ID}'",
        "datetime": FEDS_WINDOW,
        "limit": "100",
    }


def polygon_coordinates(value: object) -> list[tuple[float, float]]:
    """Check every source coordinate while keeping its original geometry intact."""
    points: list[tuple[float, float]] = []

    def walk(node: object) -> None:
        if not isinstance(node, list) or not node:
            raise SourceError("FEDS polygon contains an empty or invalid coordinate array")
        if len(node) >= 2 and all(type(n) in (float, int) for n in node[:2]):
            lon, lat = node[:2]
            if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise SourceError("FEDS polygon contains invalid longitude/latitude")
            points.append((lon, lat))
            return
        for child in node:
            walk(child)

    walk(value)
    return points


def normalize_fire_perimeters(response: dict) -> dict:
    features = response.get("features")
    matched, returned = response.get("numberMatched"), response.get("numberReturned")
    if (response.get("type") != "FeatureCollection" or not isinstance(features, list)
            or not features or type(matched) is not int or type(returned) is not int
            or matched != returned or returned != len(features)):
        raise SourceError("FEDS response is missing, incomplete, or truncated")
    normalized = []
    ids: set[int] = set()
    timestamps: set[str] = set()
    all_points: list[tuple[float, float]] = []
    for feature in features:
        if not isinstance(feature, dict) or not isinstance(feature.get("properties"), dict):
            raise SourceError("FEDS feature lacks properties")
        props = feature["properties"]
        fid = props.get("ogc_fid")
        local_time = props.get("t")
        if type(fid) is not int or fid in ids or feature.get("id") != fid:
            raise SourceError("FEDS feature ID is invalid or duplicated")
        if props.get("fireid") != FEDS_FIRE_ID or not isinstance(local_time, str):
            raise SourceError(f"FEDS feature {fid}: wrong fire or missing time")
        try:
            clock = datetime.fromisoformat(local_time)
        except ValueError as exc:
            raise SourceError(f"FEDS feature {fid}: invalid local time") from exc
        if (clock.tzinfo is not None or clock.year != 2018 or clock.month != 11
                or (clock.hour, clock.minute, clock.second) not in ((0, 0, 0), (12, 0, 0))
                or local_time in timestamps):
            raise SourceError(f"FEDS feature {fid}: unexpected or repeated snapshot time")
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            raise SourceError(f"FEDS feature {fid}: invalid polygon geometry")
        all_points.extend(polygon_coordinates(geometry.get("coordinates")))
        area = props.get("farea")
        if not isinstance(area, (int, float)) or not math.isfinite(area) or area < 0:
            raise SourceError(f"FEDS feature {fid}: invalid area")
        normalized.append({
            "type": "Feature",
            "id": f"feds-veda:{fid}",
            "geometry": geometry,
            "properties": {
                "source_id": "feds-veda-archive",
                "source_feature_id": fid,
                "incident_id": INCIDENT_ID,
                "source_fire_id": FEDS_FIRE_ID,
                "snapshot_local_time": local_time,
                "snapshot_timezone": "America/Los_Angeles",
                "snapshot_at": clock.replace(tzinfo=ZoneInfo("America/Los_Angeles")).astimezone(
                    timezone.utc
                ).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "time_precision": "half_day",
                "available_at": None,
                "evidence_class": "reconstructed",
                "method": "FEDS satellite-derived cumulative perimeter",
                "area_km2": area,
                "new_pixel_count": props.get("n_newpixels"),
            },
        })
        ids.add(fid)
        timestamps.add(local_time)
    normalized.sort(key=lambda feature: (feature["properties"]["snapshot_at"], feature["id"]))
    return {
        "type": "FeatureCollection",
        "bbox": [min(x for x, _ in all_points), min(y for _, y in all_points),
                 max(x for x, _ in all_points), max(y for _, y in all_points)],
        "features": normalized,
    }


def artifact(path: Path, root: Path) -> dict:
    content = path.read_bytes()
    return {"path": str(path.relative_to(root)), "bytes": len(content), "sha256": sha256(content)}


def package_version_for(raw_artifacts: list[dict]) -> str:
    source_hashes = [
        (item["path"], item["sha256"])
        for item in sorted(raw_artifacts, key=lambda item: item["path"])
    ]
    return sha256(canonical_json([SCHEMA_VERSION, NORMALIZER_VERSION, source_hashes]))[:16]


def max_snapshot_gap_hours(times: list[str]) -> float:
    return max(
        (datetime.fromisoformat(right.replace("Z", "+00:00"))
         - datetime.fromisoformat(left.replace("Z", "+00:00"))).total_seconds() / 3600
        for left, right in zip(times, times[1:])
    ) if len(times) > 1 else 0.0


def verify_package(package: Path) -> dict:
    manifest = read_json((package / "manifest.json").read_bytes(), "manifest")
    if (manifest.get("incident_id") != INCIDENT_ID
            or manifest.get("schema_version") != SCHEMA_VERSION
            or manifest.get("normalizer_version") != NORMALIZER_VERSION):
        raise SourceError("package incident or schema version differs from this verifier")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise SourceError("package has no artifact inventory")
    seen = set()
    raw_artifacts = []
    for entry in artifacts:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise SourceError("invalid artifact inventory entry")
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or relative in seen:
            raise SourceError(f"unsafe or duplicate artifact path: {relative}")
        seen.add(relative)
        path = package / relative
        if not path.is_file() or artifact(path, package) != entry:
            raise SourceError(f"artifact is missing or modified: {relative}")
        if relative.parts[0] == "raw":
            raw_artifacts.append(entry)
    expected_version = package_version_for(raw_artifacts)
    if expected_version != manifest.get("package_version") or package.name != expected_version:
        raise SourceError("package version does not match original source artifacts")
    ids = validate_ids(read_json((package / "raw/ids.json").read_bytes(), "ID response"))
    pages = [read_json(path.read_bytes(), str(path)) for path in sorted((package / "raw").glob("page-*.json"))]
    regenerated = normalize_pages(ids, pages)
    normalized_path = package / "normalized/damage_assessments.geojson"
    if canonical_json(regenerated) != normalized_path.read_bytes():
        raise SourceError("normalized layer does not reproduce from original source responses")
    fire = normalize_fire_perimeters(read_json(
        (package / "raw/feds-perimeters.json").read_bytes(), "FEDS response"
    ))
    fire_path = package / "normalized/fire_perimeters.geojson"
    if canonical_json(fire) != fire_path.read_bytes():
        raise SourceError("fire perimeters do not reproduce from original source response")
    layer = manifest.get("layers", {}).get("damage_assessments", {})
    outside_count = sum(feature["properties"]["outside_requested_bbox"] for feature in regenerated["features"])
    if (layer.get("count") != len(ids) or manifest.get("result_bbox") != regenerated["bbox"]
            or layer.get("outside_requested_bbox_count") != outside_count):
        raise SourceError("manifest coverage does not match normalized layer")
    fire_layer = manifest.get("layers", {}).get("fire_perimeters", {})
    times = [feature["properties"]["snapshot_at"] for feature in fire["features"]]
    if (fire_layer.get("count") != len(times) or fire_layer.get("first_snapshot_at") != times[0]
            or fire_layer.get("last_snapshot_at") != times[-1]
            or fire_layer.get("bbox") != fire["bbox"]
            or fire_layer.get("max_snapshot_gap_hours") != max_snapshot_gap_hours(times)):
        raise SourceError("manifest fire coverage does not match normalized layer")
    return manifest


def acquire(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="camp-dins-", dir=root) as temporary:
        staging = Path(temporary)
        raw = staging / "raw"
        normalized = staging / "normalized"
        raw.mkdir()
        normalized.mkdir()
        layer_bytes = request_json(LAYER_URL, "", {"f": "json"})
        layer = read_json(layer_bytes, "layer metadata")
        fields = {field.get("name") for field in layer.get("fields", [])}
        if not set(FIELDS) <= fields or layer.get("objectIdField") not in (None, "OBJECTID"):
            raise SourceError("CAL FIRE layer schema changed")
        (raw / "layer.json").write_bytes(layer_bytes)

        ids_bytes = request_json(LAYER_URL, "/query", {**common_query(), "returnIdsOnly": "true"})
        ids = validate_ids(read_json(ids_bytes, "ID response"))
        (raw / "ids.json").write_bytes(ids_bytes)

        pages = []
        for offset in range(0, len(ids), PAGE_SIZE):
            batch = ids[offset:offset + PAGE_SIZE]
            page_bytes = request_json(
                LAYER_URL,
                "/query",
                {
                    "objectIds": ",".join(map(str, batch)),
                    "outFields": ",".join(FIELDS),
                    "returnGeometry": "true",
                    "outSR": "4326",
                    "f": "json",
                },
            )
            page = read_json(page_bytes, f"page {offset // PAGE_SIZE + 1}")
            pages.append(page)
            (raw / f"page-{offset // PAGE_SIZE + 1:04d}.json").write_bytes(page_bytes)

        collection = normalize_pages(ids, pages)
        output = normalized / "damage_assessments.geojson"
        output.write_bytes(canonical_json(collection))
        feds_bytes = request_json(FEDS_URL, "", fire_query())
        (raw / "feds-perimeters.json").write_bytes(feds_bytes)
        fire = normalize_fire_perimeters(read_json(feds_bytes, "FEDS response"))
        fire_output = normalized / "fire_perimeters.geojson"
        fire_output.write_bytes(canonical_json(fire))
        fire_times = [feature["properties"]["snapshot_at"] for feature in fire["features"]]
        raw_artifacts = [artifact(path, staging) for path in sorted(raw.iterdir())]
        package_version = package_version_for(raw_artifacts)
        destination = root / INCIDENT_ID / package_version
        if destination.exists():
            verify_package(destination)
            return destination
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "normalizer_version": NORMALIZER_VERSION,
            "incident_id": INCIDENT_ID,
            "package_version": package_version,
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "incident": {"name": INCIDENT_NAME, "number": INCIDENT_NUMBER},
            "query_bbox": list(BBOX),
            "result_bbox": collection["bbox"],
            "crs": "OGC:CRS84",
            "coordinate_order": "longitude,latitude",
            "sources": {
                "calfire-dins": {
                    "url": LAYER_URL,
                    "catalog_url": "https://publish.data.ca.gov/dataset/cal-fire-damage-inspection-dins-data",
                    "license": "CC BY (per California Open Data catalog)",
                    "query": common_query(),
                    "fields": list(FIELDS),
                },
                "feds-veda-archive": {
                    "url": FEDS_URL,
                    "documentation_url": "https://docs.openveda.cloud/user-guide/notebooks/tutorials/mapping-fires.html",
                    "related_archive_url": "https://zenodo.org/records/22921773",
                    "related_archive_note": "newer CONUS archive, not the identical VEDA collection",
                    "license": "not stated on VEDA collection endpoint",
                    "query": fire_query(),
                    "fire_id_scope": "archive collection and November 2018 window",
                },
            },
            "layers": {
                "damage_assessments": {
                    "status": "present",
                    "count": len(ids),
                    "outside_requested_bbox_count": sum(
                        bool(feature["properties"]["outside_requested_bbox"])
                        for feature in collection["features"]
                    ),
                    "temporal_role": "postfire_assessment",
                    "assessment_time_status": "unavailable",
                },
                "fire_perimeters": {
                    "status": "present",
                    "count": len(fire_times),
                    "bbox": fire["bbox"],
                    "first_snapshot_at": fire_times[0],
                    "last_snapshot_at": fire_times[-1],
                    "max_snapshot_gap_hours": max_snapshot_gap_hours(fire_times),
                    "temporal_role": "satellite_derived_cumulative_perimeter",
                    "availability_status": "unknown",
                    "nominal_cadence_hours": 12,
                },
                "road_network": {"status": "missing", "reason": "not acquired in this pilot"},
                "traffic_observations": {"status": "missing", "reason": "not acquired in this pilot"},
            },
            "artifacts": raw_artifacts + [artifact(output, staging), artifact(fire_output, staging)],
        }
        (staging / "manifest.json").write_bytes(canonical_json(manifest))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), destination)
        return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=Path("data/incidents"))
    parser.add_argument("--verify-package", type=Path, help="verify an existing package without network access")
    arguments = parser.parse_args()
    try:
        if arguments.verify_package:
            manifest = verify_package(arguments.verify_package)
            print(
                f"verified {arguments.verify_package}: "
                f"{manifest['layers']['damage_assessments']['count']} assessments, "
                f"{manifest['layers']['fire_perimeters']['count']} perimeters"
            )
            return
        destination = acquire(arguments.output_root)
    except (OSError, SourceError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(destination)


if __name__ == "__main__":
    main()
