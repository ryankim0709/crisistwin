# ADR 0006: Incident package artifacts in MongoDB Atlas

Status: Accepted (2026-10-23)

## Context

Incident packages put about 80 MB in Git: road GeoJSON and raw OSM snapshots, with
the same 14 MB `road_edges.geojson` duplicated across three package versions. Each
new package version adds more, and history cannot be shrunk without rewriting it.

## Decision

Keep manifests, `sources.json`, `quality.json` and small `curated/` tables in Git.
Store all other manifest artifacts (`raw/`, `normalized/`) in MongoDB Atlas GridFS
(bucket `incident_artifacts`, database `MONGODB_DB`, default `crisistwin`), one blob per
SHA-256, so duplicates are stored once. `data/incidents/*/*/raw/` and `normalized/`
are git-ignored. `python3 -m tools.mongo_data pull|push` syncs them and checks every
file against its manifest hash; `sim/` and the verifiers still read local files and
are unchanged.

## Consequences

- A fresh clone needs `pip install -r tools/requirements.txt`, `MONGODB_URI` from a
  teammate, and `pull` before running the sim. Atlas must allow the user's IP.
- Authors run `push` after building a package and commit its manifest; an artifact
  missing from Atlas makes `pull` fail with the path and hash.
- Immutability still comes from the manifest hashes, not from Atlas.
- Files committed earlier remain in Git history.
- The connection string is a secret: keep it in the shell, not in Git or logs. A
  placeholder is in `app/.env.example`.
- Extra paths (`extracts/`, `curated/` in newer packages) are not yet ignored or
  synced specially; only manifest-listed artifacts are pushed.
