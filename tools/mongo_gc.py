"""Find and remove GridFS artifacts that no manifest references.

An artifact is kept if its SHA-256 appears in any incident ``manifest.json`` or
``app/data-manifest.json`` in the working tree or in any commit reachable from
any local or remote ref, so old package versions stay restorable from history.
Also reports duplicate uploads of one SHA-256 and chunks without a file.

  python3 -m tools.mongo_gc            # dry run: report only
  python3 -m tools.mongo_gc --delete   # delete unreferenced artifacts and orphan chunks

Run ``git fetch`` first so teammates' pushed manifests count as references.
Uses MONGODB_URI like tools.mongo_data.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from tools.mongo_data import APP_MANIFEST, BUCKET, DEFAULT_ROOT, connect

MANIFEST_SPECS = ("data/incidents/*/*/manifest.json", str(APP_MANIFEST))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def shas_in(text: str) -> set[str]:
    return {entry["sha256"] for entry in json.loads(text).get("artifacts", [])}


def referenced() -> set[str]:
    refs: set[str] = set()
    for path in [*DEFAULT_ROOT.glob("*/*/manifest.json"), APP_MANIFEST]:
        if path.is_file():
            refs |= shas_in(path.read_text())
    history = git("log", "--all", "--format=%H", "--name-only", "--diff-filter=AM", "--", *MANIFEST_SPECS)
    commit = None
    for line in history.splitlines():
        if len(line) == 40 and "/" not in line:
            commit = line
        elif line and commit:
            refs |= shas_in(git("show", f"{commit}:{line}"))
    return refs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--delete", action="store_true", help="delete what the dry run reports")
    args = parser.parse_args()

    refs = referenced()
    bucket = connect()
    db = bucket._files.database  # GridFSBucket keeps its collections private
    files, chunks = db[f"{BUCKET}.files"], db[f"{BUCKET}.chunks"]

    seen: dict[str, dict] = {}
    unreferenced, duplicates = [], []
    for doc in files.find({}, {"filename": 1, "length": 1, "uploadDate": 1, "metadata": 1}).sort("uploadDate", 1):
        if doc["filename"] not in refs:
            unreferenced.append(doc)
        elif doc["filename"] in seen:
            duplicates.append(doc)  # keep the oldest upload of each SHA-256
        else:
            seen[doc["filename"]] = doc
    file_ids = set(files.distinct("_id"))
    orphan_chunks = [cid for cid in chunks.distinct("files_id") if cid not in file_ids]
    missing = sorted(refs - {doc["filename"] for doc in files.find({}, {"filename": 1})})

    print(f"{len(refs)} referenced SHA-256s; {files.count_documents({})} stored files")
    for label, docs in (("unreferenced", unreferenced), ("duplicate", duplicates)):
        for doc in docs:
            meta = doc.get("metadata") or {}
            print(f"{label}: {doc['filename'][:12]}... {doc['length']:,} B stored, "
                  f"uploaded {doc['uploadDate']:%Y-%m-%d %H:%M}Z, first path {meta.get('first_path', '?')}")
    print(f"orphan chunk groups: {len(orphan_chunks)}")
    print(f"referenced but not in Atlas: {len(missing)} (normal for unpushed local packages)")
    freed = sum(doc["length"] for doc in unreferenced + duplicates)
    if not args.delete:
        print(f"dry run: would free {freed:,} stored bytes; rerun with --delete")
        return
    for doc in unreferenced + duplicates:
        bucket.delete(doc["_id"])
    if orphan_chunks:
        chunks.delete_many({"files_id": {"$in": orphan_chunks}})
    print(f"deleted {len(unreferenced) + len(duplicates)} files and {len(orphan_chunks)} orphan chunk groups "
          f"({freed:,} stored bytes)")


if __name__ == "__main__":
    sys.exit(main())
