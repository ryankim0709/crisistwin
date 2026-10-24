"""Sync large incident-package artifacts with MongoDB Atlas instead of Git.

Each ``data/incidents/*/*/manifest.json`` stays in Git and lists every artifact
with its byte size and SHA-256. The artifact bytes live in GridFS keyed by that
SHA-256, so identical files shared by several package versions are stored once.

  python3 -m tools.mongo_data push   # upload artifacts missing from Atlas
  python3 -m tools.mongo_data pull   # download artifacts missing locally

Generated app data (replay bundles, what-if variants, agent simulations and the
local Dewey mobility sidecars under ``app/public``) is listed the same way in the
Git-tracked ``app/data-manifest.json`` and stored gzip-compressed. After
regenerating any of it, refresh that manifest, push, and commit the manifest:

  python3 -m tools.mongo_data record  # rewrite app/data-manifest.json from local files
  python3 -m tools.mongo_data status  # compare local files with the manifests (and Atlas, if MONGODB_URI is set)

``push`` refuses to run while local app data differs from ``app/data-manifest.json``:
otherwise the new files stay local and teammates silently get the previously recorded ones.

Requires ``pip install -r tools/requirements.txt`` and the MONGODB_URI
environment variable (optionally MONGODB_DB, default "crisistwin").
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path


DEFAULT_ROOT = Path("data/incidents")
DEFAULT_DB = "crisistwin"
BUCKET = "incident_artifacts"
APP_MANIFEST = Path("app/data-manifest.json")
APP_ROOT = Path("app/public")
APP_GLOBS = ("replays/**/*.json", "simulations/**/*.json")


def connect():
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("MONGODB_URI is not set; export it in your shell (never commit it).")
    try:
        import gridfs
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pymongo is not installed; run: pip install -r tools/requirements.txt")
    db = MongoClient(uri, serverSelectionTimeoutMS=10_000)[os.environ.get("MONGODB_DB", DEFAULT_DB)]
    return gridfs.GridFSBucket(db, bucket_name=BUCKET)


def artifacts(root: Path):
    """Yield (base_dir, relative_path, bytes, sha256, compress) for every manifest artifact."""
    for manifest_path in sorted(root.glob("*/*/manifest.json")):
        manifest = json.loads(manifest_path.read_text())
        for entry in manifest["artifacts"]:
            yield manifest_path.parent, entry["path"], entry["bytes"], entry["sha256"], False
    if APP_MANIFEST.is_file():
        for entry in json.loads(APP_MANIFEST.read_text())["artifacts"]:
            yield APP_ROOT, entry["path"], entry["bytes"], entry["sha256"], True


def stored(bucket, sha256: str) -> bool:
    return next(bucket.find({"filename": sha256}, limit=1), None) is not None


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def app_drift() -> tuple[list[str], list[str], list[str]]:
    """(changed, missing, unlisted) app files relative to app/data-manifest.json."""
    listed = {e["path"]: e["sha256"] for e in json.loads(APP_MANIFEST.read_text())["artifacts"]} if APP_MANIFEST.is_file() else {}
    local = {p.relative_to(APP_ROOT).as_posix() for pattern in APP_GLOBS for p in APP_ROOT.glob(pattern) if p.is_file()}
    changed = sorted(rel for rel, sha in listed.items() if rel in local and sha256_of(APP_ROOT / rel) != sha)
    missing = sorted(set(listed) - local)
    unlisted = sorted(local - set(listed))
    return changed, missing, unlisted


def status(root: Path) -> None:
    changed, missing, unlisted = app_drift()
    for label, paths in (("differs from manifest", changed), ("missing locally", missing),
                         ("not in manifest", unlisted)):
        for rel in paths:
            print(f"{APP_ROOT / rel}: {label}")
    ok = not (changed or missing or unlisted)
    print("app data matches app/data-manifest.json" if ok else
          "app data differs: the author runs record, push, and commits the manifest; everyone else runs pull")
    if os.environ.get("MONGODB_URI"):
        bucket = connect()
        absent = [f"{base / rel}" for base, rel, _size, sha, _c in artifacts(root) if not stored(bucket, sha)]
        for path in absent:
            print(f"{path}: listed in a manifest but not in Atlas (push it from the machine that built it)")
        print(f"Atlas has {'every' if not absent else 'NOT every'} listed artifact")
        ok = ok and not absent
    else:
        print("MONGODB_URI not set: Atlas not checked")
    sys.exit(0 if ok else 1)


def record() -> None:
    entries = [
        {"path": path.relative_to(APP_ROOT).as_posix(), "bytes": path.stat().st_size, "sha256": sha256_of(path)}
        for path in sorted({p for pattern in APP_GLOBS for p in APP_ROOT.glob(pattern) if p.is_file()})
    ]
    APP_MANIFEST.write_text(json.dumps({"root": APP_ROOT.as_posix(), "artifacts": entries}, indent=1) + "\n")
    print(f"recorded {len(entries)} app artifacts ({sum(e['bytes'] for e in entries):,} bytes) in {APP_MANIFEST}")


def require_recorded() -> None:
    changed, _missing, unlisted = app_drift()
    if changed or unlisted:
        sys.exit("Local app data differs from app/data-manifest.json ("
                 + ", ".join(changed + unlisted)
                 + "). Run `python3 -m tools.mongo_data record` first, then push and commit the manifest.")


def push(bucket, root: Path) -> None:
    uploaded = skipped = 0
    for package, rel, size, sha, compress in artifacts(root):
        path = package / rel
        if stored(bucket, sha):
            skipped += 1
            continue
        if not path.is_file():
            sys.exit(f"{path} is missing locally and not in Atlas; run pull from a machine that has it.")
        if sha256_of(path) != sha:
            sys.exit(f"{path} does not match the SHA-256 in its manifest; refusing to upload.")
        data = path.read_bytes()
        metadata = {"bytes": size, "first_path": str(path)}
        if compress:
            data = gzip.compress(data, mtime=0)
            metadata["encoding"] = "gzip"
        bucket.upload_from_stream(sha, data, metadata=metadata)
        uploaded += 1
        print(f"uploaded {path} ({size:,} bytes, {len(data):,} stored)")
    print(f"push done: {uploaded} uploaded, {skipped} already in Atlas")


def pull(bucket, root: Path) -> None:
    downloaded = present = 0
    absent: list[str] = []
    for package, rel, _size, sha, _compress in artifacts(root):
        path = package / rel
        if path.is_file() and sha256_of(path) == sha:
            present += 1
            continue
        if not stored(bucket, sha):
            absent.append(f"{path} (sha256 {sha[:12]}...)")
            continue
        stream = bucket.open_download_stream_by_name(sha)
        data = stream.read()
        if (stream.metadata or {}).get("encoding") == "gzip":
            data = gzip.decompress(data)
        if hashlib.sha256(data).hexdigest() != sha:
            sys.exit(f"Atlas returned corrupt bytes for {path}.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        downloaded += 1
        print(f"downloaded {path} ({len(data):,} bytes)")
    print(f"pull done: {downloaded} downloaded, {present} already up to date")
    _changed, _missing, unlisted = app_drift()
    for rel in unlisted:
        print(f"note: {APP_ROOT / rel} is not in app/data-manifest.json (stale or unrecorded local file)")
    if absent:
        sys.exit("Not in Atlas, so left as is locally (whoever built them must push):\n  " + "\n  ".join(absent))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("push", "pull", "record", "status"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    if args.command == "record":
        record()
        return
    if args.command == "status":
        status(args.root)
    if args.command == "push":
        require_recorded()  # before connecting, so a stale manifest fails fast
    (push if args.command == "push" else pull)(connect(), args.root)


if __name__ == "__main__":
    main()
