"""Materialize incident-package artifacts from MongoDB Atlas GridFS on demand.

Per ADR 0006, manifests stay in Git and artifact bytes live in GridFS (bucket
`incident_artifacts`), one blob per SHA-256. `ensure_package` makes every artifact a
manifest lists present locally with the right hash, downloading only what is missing
or stale, so the existing offline verifiers and loaders run unchanged on Mongo data.

Data source modes:
  local  read local files only (fails later in verification if any are missing)
  mongo  always check artifacts against the manifest and fetch missing ones from Atlas
  auto   like mongo, but only connects when something is missing (default)

Requires `pymongo` (tools/requirements.txt) and MONGODB_URI (optionally MONGODB_DB)
only when a download is needed. The URI is a secret: never log or commit it.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from pathlib import Path

from tools.build_camp_history import SourceError

GRIDFS_BUCKET = "incident_artifacts"
DEFAULT_DB = "crisistwin"
DATA_SOURCES = ("auto", "local", "mongo")
SERVER_SELECTION_TIMEOUT_MS = 10_000

DATA_SOURCE_ENV = "CRISISTWIN_DATA_SOURCE"  # loaders' default mode when no CLI flag applies

Fetch = Callable[[str], bytes]  # sha256 -> artifact bytes


def default_source() -> str:
    return os.environ.get(DATA_SOURCE_ENV, "auto")


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def missing_artifacts(package: Path) -> list[dict]:
    """Manifest artifacts that are absent locally or whose bytes do not match their SHA-256."""
    manifest_path = package / "manifest.json"
    if not manifest_path.is_file():
        raise SourceError(f"{manifest_path} not found; manifests are kept in Git")
    manifest = json.loads(manifest_path.read_text())
    return [a for a in manifest["artifacts"] if _sha256_file(package / a["path"]) != a["sha256"]]


def gridfs_fetch() -> Fetch:
    """Fetch artifact bytes from Atlas GridFS by SHA-256 filename."""
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise SourceError("package artifacts are missing locally and MONGODB_URI is not set; "
                          "export it (ask a teammate) or run `python3 -m tools.mongo_data pull`")
    try:
        import gridfs
        from pymongo import MongoClient
    except ImportError as exc:
        raise SourceError("reading from MongoDB needs pymongo: pip install -r tools/requirements.txt") from exc
    client = MongoClient(uri, serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS)
    bucket = gridfs.GridFSBucket(client[os.environ.get("MONGODB_DB", DEFAULT_DB)], bucket_name=GRIDFS_BUCKET)

    def fetch(sha256: str) -> bytes:
        try:
            return bucket.open_download_stream_by_name(sha256).read()
        except gridfs.errors.NoFile as exc:
            raise SourceError(f"artifact sha256 {sha256[:12]}… is not in Atlas; its author must run push") from exc

    return fetch


def ensure_package(package: Path, *, source: str | None = None, fetch: Fetch | None = None) -> dict:
    """Make the package's manifest artifacts available locally; return a provenance record.

    Downloaded bytes are hash-checked before they are written, then the package's own
    verifier re-checks everything when it is loaded.
    """
    source = source or default_source()
    if source not in DATA_SOURCES:
        raise ValueError(f"data source must be one of {DATA_SOURCES}")
    missing = [] if source == "local" else missing_artifacts(package)
    record = {"package": str(package), "data_source": source, "fetched_from_mongodb": 0, "fetched_bytes": 0}
    if not missing:
        record["artifacts_from"] = "local"
        return record
    fetch = fetch or gridfs_fetch()
    for artifact in missing:
        data = fetch(artifact["sha256"])
        if hashlib.sha256(data).hexdigest() != artifact["sha256"] or len(data) != artifact["bytes"]:
            raise SourceError(f"MongoDB returned bytes that do not match the manifest for {artifact['path']}")
        path = package / artifact["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
        record["fetched_from_mongodb"] += 1
        record["fetched_bytes"] += len(data)
    total = len(json.loads((package / "manifest.json").read_text())["artifacts"])
    record["artifacts_from"] = "mongodb" if len(missing) == total else "local+mongodb"
    return record
