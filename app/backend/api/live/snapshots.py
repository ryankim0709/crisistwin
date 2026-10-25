"""Scenario resource snapshots: build, store and serve (docs/scenario-snapshots.md).

The builder is pure (``livecore.snapshot``); this module adds the inputs only Django can reach
(the incident's drill file, the cached dispatch area's synthetic home points, the assumptions
file), the MongoDB writes (``scenario_snapshots``, ``snapshot_households``,
``snapshot_stations``; validators in ``schema.py``) and the two GET endpoints.

One current snapshot per incident. Re-seeding writes the children under a new ``snapshot_id``,
then replaces the incident's ``scenario_snapshots`` document (the flip), then deletes the
incident's children of any other ``snapshot_id``. Readers always go through the snapshot
document, so they never see a half-written snapshot.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from pymongo.errors import PyMongoError

from livecore.snapshot import BUILDER, build_snapshot, effective_config

from . import incidents
from .auth import Principal, live_view
from .common import ApiError, col, iso, ok, wall_now

log = logging.getLogger(__name__)

SNAPSHOTS = "scenario_snapshots"
HOUSEHOLDS = "snapshot_households"
STATIONS = "snapshot_stations"
ASSUMPTIONS_ENV = "SCENARIO_SNAPSHOT_ASSUMPTIONS"
DEFAULT_ASSUMPTIONS = "tools/snapshot_assumptions.json"
INSERT_BATCH = 1000
HOUSEHOLDS_LIMIT_DEFAULT = 500
HOUSEHOLDS_LIMIT_MAX = 2000
DEFAULT_INCIDENTS = ("camp-2018-drill", "studio-f5caaabd2a1e", "studio-1dfbd182d416")
"""The live drills ``live_seed_snapshots`` seeds without ``--incident``."""
DISPATCH_AREAS = "dispatch_areas"


def _repo_root() -> Path:
    from .twin_service import REPO_ROOT

    return REPO_ROOT


def assumptions_path(override: str | None = None) -> Path:
    """``override`` (``--assumptions``), else ``$SCENARIO_SNAPSHOT_ASSUMPTIONS``, else the repo file."""
    raw = override or os.environ.get(ASSUMPTIONS_ENV) or DEFAULT_ASSUMPTIONS
    path = Path(raw)
    return path if path.is_absolute() else _repo_root() / path


def load_assumptions(override: str | None = None) -> tuple[dict[str, Any], Path, str]:
    path = assumptions_path(override)
    raw = path.read_bytes()
    return json.loads(raw), path, hashlib.sha256(raw).hexdigest()


def _area_home_points(bundle: dict[str, Any]) -> tuple[dict[str, list[tuple[float, float]]] | None, str]:
    """Synthetic home points per zone from the dispatch area that built the package, when MongoDB
    still caches that exact build (same builder, bbox and ``generatedAt``). Never fetches OSM."""
    meta = (bundle.get("drill_package") or {}).get("dispatch_area") or {}
    bbox, builder = meta.get("bbox"), meta.get("builder")
    if not (isinstance(bbox, list) and len(bbox) == 4 and builder):
        return None, "package names no dispatch area"
    key = f"{builder}:{bbox[0]:.2f},{bbox[1]:.2f},{bbox[2]:.2f},{bbox[3]:.2f}"
    try:
        doc = col(DISPATCH_AREAS).find_one({"_id": key})
    except PyMongoError:
        return None, "dispatch area cache unavailable"
    if not doc or not doc.get("gz"):
        return None, f"dispatch area {key} not cached"
    try:
        area = json.loads(gzip.decompress(bytes(doc["gz"])))
    except (OSError, ValueError):
        return None, f"dispatch area {key} unreadable"
    if area.get("generatedAt") != meta.get("generated_at"):
        return None, f"cached dispatch area {key} is a later build than the package's"
    zone_ids = [str(z["id"]) for z in area.get("zones") or []]
    out: dict[str, list[tuple[float, float]]] = {}
    for lon, lat, zi in area.get("homes") or []:
        out.setdefault(zone_ids[int(zi)], []).append((float(lon), float(lat)))
    return out, f"dispatch area {key} homes"


def build(incident_id: str, assumptions: str | None = None) -> dict[str, Any]:
    """Build (not store) the snapshot of ``incident_id``. Raises ``ApiError(404)`` for an unknown incident."""
    source = incidents.source_for(incident_id)
    if source is None:
        raise ApiError(404, "not_found", "Unknown incident.")
    config, path, digest = load_assumptions(assumptions)
    bundle = json.loads(source.path.read_text(encoding="utf-8"))
    homes, homes_note = (None, "replay bundle: no home points")
    if source.kind == "package":
        homes, homes_note = _area_home_points(bundle)
    built = build_snapshot(incident_id, bundle, effective_config(config, incident_id), home_points=homes)
    snap = built["snapshot"]
    snap["config"] = {"path": str(path), "sha256": digest}
    snap["notes"] = [f"home points: {homes_note}", *snap["notes"]]
    return built


def store(built: dict[str, Any]) -> dict[str, Any]:
    """Write a built snapshot and make it the incident's current one. Returns the snapshot document."""
    snap = dict(built["snapshot"])
    incident_id = snap["incident_id"]
    snapshot_id = f"snap_{snap['content_hash'][:12]}_{uuid.uuid4().hex[:6]}"
    tag = {"snapshot_id": snapshot_id, "incident_id": incident_id}
    households = [{**tag, **h} for h in built["households"]]
    for i in range(0, len(households), INSERT_BATCH):
        col(HOUSEHOLDS).insert_many(households[i:i + INSERT_BATCH], ordered=False)
    if built["stations"]:
        col(STATIONS).insert_many([{**tag, **s} for s in built["stations"]], ordered=False)
    doc = {**snap, "snapshot_id": snapshot_id, "created_at": wall_now()}
    col(SNAPSHOTS).replace_one({"incident_id": incident_id}, doc, upsert=True)  # the flip
    for name in (HOUSEHOLDS, STATIONS):
        col(name).delete_many({"incident_id": incident_id, "snapshot_id": {"$ne": snapshot_id}})
    return doc


def current(incident_id: str) -> dict[str, Any] | None:
    return col(SNAPSHOTS).find_one({"incident_id": incident_id}, {"_id": 0})


def ensure(incident_id: str) -> dict[str, Any] | None:
    """The current snapshot, built and stored first when absent (activation path). Logs and
    returns None when it cannot be built: activation never fails because of a snapshot."""
    try:
        doc = current(incident_id)
        if doc is not None:
            return doc
        doc = store(build(incident_id))
        log.info("scenario snapshot %s built for %s: %s", doc["snapshot_id"], incident_id, doc["totals"])
        return doc
    except (ApiError, OSError, ValueError, KeyError, PyMongoError):
        log.exception("scenario snapshot: cannot build for %s", incident_id)
        return None


_building: set[str] = set()
_building_lock = threading.Lock()


def ensure_background(incident_id: str) -> None:
    """``ensure`` in a daemon thread (once at a time per incident). Storing takes minutes on a
    rate-limited Atlas tier, so activation does not wait; the twin computes the same per-zone demand
    itself meanwhile (``twin_service._snapshot_zone_vehicles``)."""
    with _building_lock:
        if incident_id in _building:
            return
        _building.add(incident_id)

    def run() -> None:
        try:
            ensure(incident_id)
        finally:
            with _building_lock:
                _building.discard(incident_id)

    threading.Thread(target=run, name=f"snapshot-{incident_id}", daemon=True).start()


def zone_evacuating_vehicles(incident_id: str) -> dict[str, int] | None:
    """``{zone_id: evacuating vehicles}`` of the current snapshot (the twin's demand), or None."""
    try:
        doc = col(SNAPSHOTS).find_one({"incident_id": incident_id}, {"zones": 1, "snapshot_id": 1})
    except PyMongoError:
        log.warning("scenario snapshot: MongoDB unavailable; twin keeps the package demand")
        return None
    if not doc or not doc.get("zones"):
        return None
    return {str(z["zone_id"]): int(z["evacuating_vehicles"]) for z in doc["zones"]}


def stations(incident_id: str, snapshot_id: str) -> list[dict[str, Any]]:
    return list(col(STATIONS).find({"incident_id": incident_id, "snapshot_id": snapshot_id},
                                   {"_id": 0, "snapshot_id": 0, "incident_id": 0}).sort("station_id", 1))


def _snapshot_json(doc: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in doc.items() if k not in ("_id",)}
    out["scenario_time"] = iso(doc.get("scenario_time"))
    out["created_at"] = iso(doc.get("created_at"))
    return out


def _require(incident_id: str) -> dict[str, Any]:
    doc = current(incident_id)
    if doc is None:
        raise ApiError(404, "no_snapshot", "No resource snapshot for this incident; run live_seed_snapshots.")
    return doc


@live_view(["GET"])
def incident_snapshot(request, incident_id: str, principal: Principal):
    doc = _require(incident_id)
    body = _snapshot_json(doc)
    body["stations"] = stations(incident_id, doc["snapshot_id"])
    return ok(body)


@live_view(["GET"])
def snapshot_households(request, incident_id: str, principal: Principal):
    doc = _require(incident_id)
    try:
        limit = int(request.query_params.get("limit") or HOUSEHOLDS_LIMIT_DEFAULT)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", "`limit` must be an integer.") from exc
    if not 1 <= limit <= HOUSEHOLDS_LIMIT_MAX:
        raise ApiError(400, "invalid_request", f"`limit` must be 1..{HOUSEHOLDS_LIMIT_MAX}.")
    query: dict[str, Any] = {"snapshot_id": doc["snapshot_id"]}
    zone_id = request.query_params.get("zone_id")
    if zone_id:
        query["zone_id"] = zone_id
    after = request.query_params.get("after")
    if after:
        query["household_id"] = {"$gt": after}
    rows = list(col(HOUSEHOLDS).find(query, {"_id": 0, "snapshot_id": 0, "incident_id": 0})
                .sort("household_id", 1).limit(limit + 1))
    more = len(rows) > limit
    rows = rows[:limit]
    return ok({
        "incident_id": incident_id, "snapshot_id": doc["snapshot_id"], "zone_id": zone_id or None,
        "households": rows, "next": rows[-1]["household_id"] if more else None,
    })


__all__ = ["BUILDER", "DEFAULT_INCIDENTS", "build", "current", "ensure", "ensure_background", "store",
           "zone_evacuating_vehicles"]
