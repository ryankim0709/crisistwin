"""Which incidents the live API serves, and the one active wildfire (docs/adr/0047-active-incident.md).

An incident is backed by a drill source: the configured replay bundle (Camp, ``camp-2018-drill``)
or a stored Studio drill package (``studio-<hex>``, ``{LIVE_PACKAGES_DIR}/pkg_<hex>.json``). The
hosted instance has one **active** incident (ADR 0030 item 5), stored in MongoDB ``live_active``
(one document, ``_id: "active"``); without one it is the settings default (Camp). The live API
serves Camp and the active incident; any other incident id is unknown (404).

The active record is read at most every ``ACTIVE_CACHE_S`` per process; a switch in this process
clears the cache, another process sees it within that time.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from django.conf import settings
from livecore.drill import DRILL_LABEL, INCIDENT_ID, INCIDENT_NAME
from pymongo.errors import PyMongoError

from .common import col, iso

log = logging.getLogger(__name__)

ACTIVE_DOC_ID = "active"
ACTIVE_CACHE_S = 2.0
PACKAGE_INCIDENT_RE = re.compile(r"studio-([0-9a-f]{12})")
PACKAGE_ID_RE = re.compile(r"pkg_([0-9a-f]{12})")
ACTIVE_MODES = {"drill"}

_request_incident: ContextVar[str | None] = ContextVar("live_request_incident", default=None)
_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "doc": None}


@dataclass(frozen=True)
class Source:
    """Where an incident's drill comes from. ``kind``: ``bundle`` (replay bundle, ``load_drill``) or
    ``package`` (Studio drill package, ``load_package``)."""

    incident_id: str
    kind: str
    path: Path
    package_id: str | None = None
    name: str | None = None
    label: str | None = None


def bundle_path() -> Path:
    """``LIVE_DRILL_BUNDLE`` (default: ``app/public/replays/camp-2018.json``)."""
    configured = (getattr(settings, "LIVE_DRILL_BUNDLE", "") or "").strip()
    if configured:
        return Path(configured)
    return Path(settings.BASE_DIR).parent / "public" / "replays" / "camp-2018.json"


def camp_source() -> Source:
    return Source(INCIDENT_ID, "bundle", bundle_path(), None, INCIDENT_NAME, DRILL_LABEL)


def package_source(package_id: str) -> Source | None:
    """The stored package ``package_id`` (``pkg_<12 hex>``), or None when it is not stored."""
    from .packages import packages_dir  # local: packages imports this module's dependents

    if not PACKAGE_ID_RE.fullmatch(package_id or ""):
        return None
    path = packages_dir() / f"{package_id}.json"
    meta_path = packages_dir() / f"{package_id}.meta.json"
    if not path.exists() or not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        incident_id = str(meta["incident_id"])
        summary = meta.get("summary") or {}
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("live: unreadable package meta %s", meta_path.name)
        return None
    return Source(incident_id, "package", path, package_id, summary.get("name"), summary.get("label"))


def source_for(incident_id: str) -> Source | None:
    """The drill source of ``incident_id`` (Camp or a stored package), or None."""
    if incident_id == INCIDENT_ID:
        return camp_source()
    m = PACKAGE_INCIDENT_RE.fullmatch(incident_id or "")
    if m is None:
        return None
    source = package_source(f"pkg_{m.group(1)}")
    return source if source is not None and source.incident_id == incident_id else None


def default_incident_id() -> str:
    return getattr(settings, "LIVE_ACTIVE_INCIDENT_ID", "") or INCIDENT_ID


def _read_active_doc() -> dict[str, Any] | None:
    now = time.monotonic()
    with _cache_lock:
        if now - _cache["at"] < ACTIVE_CACHE_S:
            return _cache["doc"]
    try:
        doc = col("live_active").find_one({"_id": ACTIVE_DOC_ID})
    except PyMongoError:
        log.warning("live: cannot read the active incident; using the default")
        doc = None
    with _cache_lock:
        _cache.update(at=now, doc=doc)
    return doc


def clear_cache() -> None:
    with _cache_lock:
        _cache.update(at=0.0, doc=None)


def active_incident_id() -> str:
    doc = _read_active_doc()
    return str(doc["incident_id"]) if doc and doc.get("incident_id") else default_incident_id()


def request_incident() -> str:
    """The incident of the current request (its URL), else the active one."""
    return _request_incident.get() or active_incident_id()


def set_request_incident(incident_id: str | None):
    return _request_incident.set(incident_id)


def reset_request_incident(token) -> None:
    _request_incident.reset(token)


def is_known(incident_id: str) -> bool:
    """Served by the live API: Camp, or the active incident when its source exists."""
    if incident_id == INCIDENT_ID:
        return True
    return incident_id == active_incident_id() and source_for(incident_id) is not None


def active_json() -> dict[str, Any]:
    """``GET /api/live/active``: the instance's one incident (no secret in it)."""
    doc = _read_active_doc()
    mode = getattr(settings, "LIVE_ACTIVE_MODE", "drill")
    if doc and doc.get("incident_id"):
        body = {
            "incident_id": doc["incident_id"],
            "name": doc.get("name") or doc["incident_id"],
            "label": doc.get("label") or DRILL_LABEL,
            "source": doc.get("source") or "bundle",
            "package_id": doc.get("package_id"),
            "activated_at": iso(doc.get("activated_at")),
        }
    else:
        body = {
            "incident_id": default_incident_id(),
            "name": getattr(settings, "LIVE_ACTIVE_NAME", "") or INCIDENT_NAME,
            "label": getattr(settings, "LIVE_ACTIVE_LABEL", "") or DRILL_LABEL,
            "source": "bundle",
            "package_id": None,
            "activated_at": None,
        }
    return {
        **body,
        "mode": mode if mode in ACTIVE_MODES else "drill",
        # True when an invite code is configured, so responders must present it. False means
        # responder join is closed (the join endpoint answers 403); civilians need no code.
        "join": {"invite_required": bool(getattr(settings, "LIVE_INVITE_CODE", ""))},
    }


def activate(source: Source, actor: str, now: datetime) -> bool:
    """Make ``source`` the active incident. Returns whether the active incident changed."""
    changed = source.incident_id != active_incident_id()
    col("live_active").update_one(
        {"_id": ACTIVE_DOC_ID},
        {"$set": {
            "incident_id": source.incident_id,
            "source": "package" if source.kind == "package" else "bundle",
            "package_id": source.package_id,
            "bundle": str(source.path),
            "name": source.name or source.incident_id,
            "label": source.label or DRILL_LABEL,
            "activated_at": now,
            "actor": actor,
        }},
        upsert=True,
    )
    clear_cache()
    return changed
