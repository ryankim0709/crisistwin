"""The 2018 ground record: de-identified 911, radio and rescue entries from the NIST reports.

Built by ``tools/camp_ground_record.py`` into ``tools/camp_ground_record.json`` (path override:
``LIVE_GROUND_RECORD``). Each item keeps a template summary, a road name and a ~100 m point;
the API places items by zone only and never returns the point. Absent file -> ``available: false``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any

from django.conf import settings
from livecore import injects as rules
from livecore.drill import INCIDENT_ID
from livecore.geo import point_in_multipolygon

from pymongo import UpdateOne

from .common import ApiError, col, iso, new_id, parse_iso
from . import injects as injects_mod
from .drillcache import DrillIndex, snap_to_segment

log = logging.getLogger(__name__)

WINDOW_MIN = 30
"""Zone activity counts the items of the last this many drill minutes."""
ITEMS_LIMIT = 100
CHANNELS = ("911", "radio", "rescue", "notification", "evacuation")
HELP_CATEGORIES = frozenset({"help_needed", "trapped"})
REPORT_KIND = {
    "road_blocked": "road_blocked",
    "heavy_traffic": "heavy_traffic",
    "fire_seen": "fire_seen",
    "trapped": "help_needed",
    "help_needed": "help_needed",
}
"""Record categories that enter the review queue as reports; the rest stay in the panel only."""
EVIDENCE_CLASS = "historical_record"
PARTY_KEY = "record_nist_2018"
ITEM_KEYS = ("id", "at", "time_precision", "channel", "category", "road_name", "summary", "evidence_class",
             "source_locator")


@dataclass(frozen=True)
class GroundRecord:
    available: bool
    items: tuple[tuple[datetime, dict[str, Any]], ...]
    """``(at, item)`` ascending; each item carries ``zone_id`` and no point."""
    points: dict[str, tuple[float, float]]
    """Item id -> its ~100 m point, for reports in the controller's queue only (never public)."""


_record: GroundRecord | None = None
_lock = Lock()


def record_path() -> Path:
    configured = (getattr(settings, "LIVE_GROUND_RECORD", "") or "").strip()
    if configured:
        return Path(configured)
    return Path(settings.BASE_DIR).parent.parent / "tools" / "camp_ground_record.json"


def _zone_of(index: DrillIndex, coord: Any) -> str | None:
    if not (isinstance(coord, list) and len(coord) == 2):
        return None
    point = (float(coord[0]), float(coord[1]))
    for zone in index.zones.values():
        if point_in_multipolygon(point, zone.geometry):
            return zone.id
    return None


def _load(index: DrillIndex) -> GroundRecord:
    path = record_path()
    if not path.exists():
        return GroundRecord(False, (), {})
    points: dict[str, tuple[float, float]] = {}
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh).get("items") or []
        items = []
        for row in raw:
            item = {k: row.get(k) for k in ITEM_KEYS}
            item["zone_id"] = _zone_of(index, row.get("coord"))
            coord = row.get("coord")
            if isinstance(coord, list) and len(coord) == 2:
                points[item["id"]] = (float(coord[0]), float(coord[1]))
            items.append((parse_iso(row["at"], "at", "invalid_record"), item))
    except (OSError, ValueError, KeyError, TypeError, ApiError) as exc:
        log.warning("live: ground record %s unreadable: %s", path, exc)
        return GroundRecord(False, (), {})
    items.sort(key=lambda pair: pair[0])
    return GroundRecord(True, tuple(items), points)


NO_RECORD = GroundRecord(False, (), {})


def get_record(index: DrillIndex) -> GroundRecord:
    """The 2018 Camp record; other incidents (Studio packages) have none."""
    global _record
    if index.drill.incident_id != INCIDENT_ID:
        return NO_RECORD
    # Retry while the file is missing, so a record built after start-up appears without a restart.
    if _record is None or not _record.available:
        with _lock:
            if _record is None or not _record.available:
                _record = _load(index)
    return _record


def _rerouted(psap: dict[str, Any], at: datetime, item: dict[str, Any]) -> bool:
    """A 911 entry of a zone whose calls a ``psap_reroute`` inject sends elsewhere at ``at``."""
    return item["channel"] == "911" and item["zone_id"] in psap and rules.in_window(psap[item["zone_id"]], at)


def ground_record_json(index: DrillIndex, until: datetime, injects: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Items up to drill time ``until`` (newest first), totals so far and per-zone activity in the window.

    ``injects``: a ``psap_reroute`` drops the 911 entries of its zones from its time on."""
    record = get_record(index)
    psap = injects_mod.psap_windows(injects)
    past = [(at, item) for at, item in record.items if at <= until and not _rerouted(psap, at, item)]
    since = until - timedelta(minutes=WINDOW_MIN)
    totals = dict.fromkeys(CHANNELS, 0)
    window = dict.fromkeys(CHANNELS, 0)
    zones: dict[str, dict[str, int]] = {}
    for at, item in past:
        channel = item["channel"]
        if channel in totals:
            totals[channel] += 1
        if at < since:
            continue
        if channel in window:
            window[channel] += 1
        if item["zone_id"]:
            z = zones.setdefault(item["zone_id"], {"items": 0, "help": 0, "fire": 0})
            z["items"] += 1
            z["help"] += item["category"] in HELP_CATEGORIES
            z["fire"] += item["category"] == "fire_seen"
    return {
        "available": record.available,
        "label": "2018 record, de-identified from NIST TN 2252. Not drill reports.",
        "window_min": WINDOW_MIN,
        "until": iso(until),
        "totals": totals,
        "window": window,
        "zones": [{"zone_id": zid, **counts} for zid, counts in sorted(zones.items())],
        "items": [item for _, item in past[::-1][:ITEMS_LIMIT]],
    }


_materialized: dict[str, set[str]] = {}
"""Per incident, record ids already upserted as reports by this process (saves a DB round trip per poll)."""


def forget(incident_id: str) -> None:
    """After a drill reset: the next polls re-check the record against the reports collection."""
    _materialized.pop(incident_id, None)


def _wall_at(at: datetime, clock: Any, wall: datetime) -> datetime:
    """Wall time at which the drill clock showed ``at`` (so queue ages read in drill time); ``wall``
    when the clock is paused or was never started."""
    if not clock.running or clock.started_at is None or clock.speed <= 0:
        return wall
    return min(wall, clock.started_at + (at - clock.replay_start) / clock.speed)


def materialize_due(index: DrillIndex, incident_id: str, clock: Any, wall: datetime,
                    injects: list[dict[str, Any]] | None = None) -> int:
    """Upsert record items that the drill clock has passed into ``live_reports`` as unverified
    ``historical_record`` reports, so they join the review queue. Idempotent by ``client_id``.
    They count for nothing (corroboration, public map, road state, fire) until a controller
    confirms them (see ``state.load_public``). Returns how many were new to this process.

    A ``psap_reroute`` inject drops the 911 entries of its zones from its time on (``injects``)."""
    record = get_record(index)
    if not record.available:
        return 0
    replay_now = clock.replay_now
    done = _materialized.setdefault(incident_id, set())
    psap = injects_mod.psap_windows(injects)
    ops = []
    for at, item in record.items:
        if at > replay_now:
            break
        if _rerouted(psap, at, item):
            continue
        kind = REPORT_KIND.get(item["category"])
        point = record.points.get(item["id"])
        if item["id"] in done or kind is None or point is None:
            continue
        snapped = snap_to_segment(index, point) if kind in ("road_blocked", "heavy_traffic") else None
        road_ref = (
            {"segment_id": snapped[0], "name": index.segment_names.get(snapped[0]), "snap_m": round(snapped[1], 1)}
            if snapped else None
        )
        doc = {
            "id": new_id("rpt_"),
            "client_id": f"record:{item['id']}",
            "incident_id": incident_id,
            "reporter": {"role": "responder" if item["channel"] == "radio" else "civilian", "party_key": PARTY_KEY},
            "kind": kind,
            "severity": "full" if kind == "road_blocked" else None,
            "location": {"coord": [point[0], point[1]], "accuracy_m": 100.0},
            "heading_deg": None,
            "road_ref": road_ref,
            "destination_id": None,
            "task_id": None,
            "observed_at": _wall_at(at, clock, wall),
            "received_at": _wall_at(at, clock, wall),
            "note": f"2018 record: {item['summary']}",
            "status": "unverified",
            "evidence_class": EVIDENCE_CLASS,
            "replay_at": at,
            "updated_at": wall,
            "record": {"id": item["id"], "channel": item["channel"], "source_locator": item["source_locator"]},
        }
        ops.append(UpdateOne({"incident_id": incident_id, "client_id": doc["client_id"]}, {"$setOnInsert": doc},
                             upsert=True))
        done.add(item["id"])
    if ops:
        col("live_reports").bulk_write(ops, ordered=False)
    return len(ops)
