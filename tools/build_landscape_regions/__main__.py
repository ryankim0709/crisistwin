"""Upload prebuilt landscape packages to MongoDB GridFS (ADR 0013).

Build packages first with ``node tools/build_landscape_regions/run.mjs``, then:

  python3 -m tools.build_landscape_regions upload [--dry-run]   # upload missing packages
  python3 -m tools.build_landscape_regions list                 # newest stored package per region

Packages are content-addressed: the GridFS filename in bucket ``landscape_packages`` is
the SHA-256 of the gzip bytes, so re-running ``upload`` is idempotent. MONGODB_URI is read
from the environment, then ``~/.mongodb_uri``, then ``app/.env``; it is never printed.
MONGODB_DB defaults to "crisistwin".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / "data" / "landscapes"
DEFAULT_DB = "crisistwin"
BUCKET = "landscape_packages"
FORMAT_VERSION = 1
CATALOGUE_FIELDS = ("name", "counties", "summary", "center", "radiusMeters")
LATTICE_FIELDS = (
    "width",
    "height",
    "cellMeters",
    "groundCellSizeMeters",
    "originX",
    "originY",
    "cellSizeX",
    "cellSizeY",
    "resampling",
)


def _env_file_value(path: Path, key: str) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.removeprefix("export ").split("=", 1)
        if name.strip() == key:
            value = value.strip().strip('"').strip("'")
            return value or None
    return None


def setting(key: str) -> str | None:
    """Environment first, then ~/.mongodb_uri (URI only), then app/.env."""
    if os.environ.get(key):
        return os.environ[key]
    if key == "MONGODB_URI":
        home_file = Path.home() / ".mongodb_uri"
        if home_file.is_file() and (uri := home_file.read_text().strip()):
            return uri
    return _env_file_value(REPO / "app" / ".env", key)


def connect():
    uri = setting("MONGODB_URI")
    if not uri:
        sys.exit(
            "MONGODB_URI is not set. Export it, put it in ~/.mongodb_uri (chmod 600) or in "
            "app/.env (git-ignored). Never commit it."
        )
    try:
        import gridfs
        from pymongo import ASCENDING, DESCENDING, MongoClient
    except ImportError:
        sys.exit("pymongo is not installed; run `pip install -r tools/requirements.txt`.")
    client = MongoClient(uri, serverSelectionTimeoutMS=10_000)
    db = client[setting("MONGODB_DB") or DEFAULT_DB]
    try:
        client.admin.command("ping")
    except Exception as error:  # noqa: BLE001 - report the class, never the URI
        sys.exit(f"Could not connect to MongoDB ({type(error).__name__}). Check the URI and Atlas IP access.")
    return db, gridfs.GridFSBucket(db, bucket_name=BUCKET), (ASCENDING, DESCENDING)


def load_manifest(root: Path) -> list[dict]:
    path = root / "manifest.json"
    if not path.is_file():
        sys.exit(f"{path} not found; build packages first with `node tools/build_landscape_regions/run.mjs`.")
    regions = json.loads(path.read_text()).get("regions", [])
    for entry in regions:
        for key in ("regionId", "sha256", "path", "builtAt", "bytes", "lattice", *CATALOGUE_FIELDS):
            if key not in entry:
                sys.exit(f"Manifest entry {entry.get('regionId', '?')} is missing {key}.")
    return regions


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"builtAt {value} has no time zone")
    return parsed.astimezone(timezone.utc)


def metadata_for(entry: dict) -> dict:
    """GridFS metadata per ADR 0013; the API lists regions from these fields alone."""
    meta = {
        "regionId": entry["regionId"],
        "builtAt": parse_utc(entry["builtAt"]),
        "formatVersion": entry.get("formatVersion", FORMAT_VERSION),
        "bytes": entry["bytes"],
        "lattice": {key: entry["lattice"][key] for key in LATTICE_FIELDS},
    }
    for key in CATALOGUE_FIELDS:
        meta[key] = entry[key]
    meta["elevationComplete"] = entry.get("elevationComplete")
    meta["canopyComplete"] = entry.get("canopyComplete")
    meta["sources"] = entry.get("sources")
    return meta


def verified_bytes(root: Path, entry: dict) -> bytes:
    path = root / entry["path"]
    if not path.is_file():
        sys.exit(f"{path} is listed in the manifest but missing; rebuild {entry['regionId']}.")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != entry["sha256"] or len(data) != entry["bytes"]:
        sys.exit(f"{path} does not match its manifest SHA-256/size; refusing to upload.")
    return data


def upload(root: Path, dry_run: bool) -> None:
    regions = load_manifest(root)
    for entry in regions:
        verified_bytes(root, entry)
    has_uri = setting("MONGODB_URI") is not None
    if dry_run and not has_uri:
        print("dry run without MONGODB_URI: cannot check Atlas, listing every manifest package")
        for entry in regions:
            print(f"would upload {entry['regionId']} {entry['sha256'][:12]} ({entry['bytes']:,} bytes)")
        return
    db, bucket, (ascending, descending) = connect()
    uploaded = skipped = 0
    for entry in regions:
        sha = entry["sha256"]
        if db[f"{BUCKET}.files"].find_one({"filename": sha}, projection={"_id": 1}):
            skipped += 1
            print(f"present  {entry['regionId']} {sha[:12]}")
            continue
        if dry_run:
            print(f"would upload {entry['regionId']} {sha[:12]} ({entry['bytes']:,} bytes)")
            continue
        bucket.upload_from_stream(sha, verified_bytes(root, entry), metadata=metadata_for(entry))
        uploaded += 1
        print(f"uploaded {entry['regionId']} {sha[:12]} ({entry['bytes']:,} bytes)")
    if not dry_run:
        db[f"{BUCKET}.files"].create_index(
            [("metadata.regionId", ascending), ("metadata.builtAt", descending)],
            name="region_newest",
        )
        print(f"upload done: {uploaded} uploaded, {skipped} already in Atlas")


def list_stored() -> None:
    db, _bucket, _order = connect()
    pipeline = [
        {"$match": {"metadata.regionId": {"$type": "string"}}},
        {"$sort": {"metadata.builtAt": -1, "uploadDate": -1}},
        {"$group": {"_id": "$metadata.regionId", "doc": {"$first": "$$ROOT"}, "versions": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]
    rows = list(db[f"{BUCKET}.files"].aggregate(pipeline))
    if not rows:
        print("no landscape packages stored")
    for row in rows:
        doc, meta = row["doc"], row["doc"].get("metadata", {})
        lattice = meta.get("lattice", {})
        built = meta.get("builtAt")
        built = built.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(built, datetime) else built
        print(
            f"{row['_id']:<28} {lattice.get('width')}x{lattice.get('height')} @ {lattice.get('cellMeters')} m"
            f"  {doc.get('length', 0) / 1e6:6.2f} MB  built {built}  {doc['filename'][:12]}"
            f"  ({row['versions']} version{'s' if row['versions'] != 1 else ''})"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("upload", "list"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="package directory with manifest.json")
    parser.add_argument("--dry-run", action="store_true", help="upload: show what would be uploaded")
    args = parser.parse_args()
    if args.command == "upload":
        upload(args.root, args.dry_run)
    else:
        list_stored()


if __name__ == "__main__":
    main()
