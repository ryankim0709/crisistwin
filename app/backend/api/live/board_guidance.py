"""Resident guidance from the Live board's evacuation orders (simulated board, labelled drill).

What the AI agent (or the controller) orders on the /live command board is what residents' phones
are told: the board runs in the controller's browser (``app/src/demo/model.ts`` ``applyOrder``),
and every run-state PUT that holds the single-writer lease (``run_state.py``) hands its zones'
order blocks here. A zone whose board order changed gets a new ``live_guidance`` version, in the
shape the proposal flow wrote (``ZoneGuidance``, docs/live-reports.md "Zones and guidance"), so the
phone endpoints (``situation``, ``me/destination``, ``phone-view``, voice facts) need no change.

Order status (``model.ts`` ``zoneOrderStatus``) -> guidance:

- ``leaving`` / ``done``: ``evacuate_now`` ("Leave now") to the order's destination on the order's
  route (the board's own route option, sent along as ``order.route``). ``done`` keeps the order in
  force (everyone who leaves has left; nobody goes back), so it is not a new version.
- ``scheduled``: ``be_ready`` with the route and ``reason`` "Leave at T+01:30 on the simulated board
  clock ...". A new start minute or destination is a new version.
- ``warning`` (``warn_evacuation``, ``app/src/demo/evacWarning.ts``): ``be_ready`` with the route to
  be ready for, no start (``board_start_minute`` null), ``reason_code: "board_warning"``. Withdrawing
  it (status back to ``none``) publishes ``level: none`` "Evacuation warning withdrawn ...".
- ``none``: withdraws (``level: none``) whatever the zone was last told: a cancelled schedule, a
  new board run (Reset board), or guidance left over from the former proposal flow.
- ``lifted``: the order was lifted (fire contained). A zone that had been told something gets
  ``level: none`` with ``reason_code: "board_all_clear"`` and a reason telling residents they may
  return; the phone view shows it as an all-clear. Never-told zones are left alone.
- ``overrun``: fire reached the zone core on the board. A zone that had been told something gets
  ``evacuate_now`` with ``no_route`` (the phone says "No open route. Shelter in place and tap Need
  help."); a zone never told anything is left alone.

A new version is written only when the level, destination, the road to leave by (``via[0]``), the
scheduled start or the source changes; a refreshed route line, ETA or safety for the same
destination and road updates the current version in place (as ``controller.refresh_published``
does). Every board document is labelled ``source: "board"``, ``issued_by`` (``ai_agent`` or
``controller``, the actor of the zone's latest board order; null when unknown) and
``evidence_class: "simulated"``. ``approved_by`` stays ``controller`` and ``proposal_id`` is
``board:<run_id>``: the collection validator and the iOS decoder accept only those shapes. Each
published change also logs one ``live_decisions`` entry (``action: "board_guidance"``) whose note
is the activity-feed line, e.g. "Residents of Z35 told: Leave now via I-980 (south)".

Nothing here computes a route or a level: destination, road, ETA and line are the board's route
option (``POST /api/demo/routes``); this module only maps them to the guidance shape.
"""

from __future__ import annotations

import logging
import math
import threading
from datetime import datetime
from typing import Any

import pymongo
from pymongo.errors import BulkWriteError, DuplicateKeyError

from livecore.planner import NEAR_FIRE_CAVEAT, THROUGH_FIRE_CAVEAT

from .common import col
from .drillcache import DrillIndex, get_index
from .state import COORD_DECIMALS, ROUTE_DISTANCE_ROUND_M, destination_json, invalidate_guidance, report_replay_at

log = logging.getLogger(__name__)

GUIDANCE = "live_guidance"
SOURCE = "board"
ALL_CLEAR = "board_all_clear"
WARNING = "board_warning"
"""``reason_code`` of an evacuation warning: level ``be_ready`` with no scheduled start."""
"""``reason_code`` of a lifted order: level ``none`` (the iOS decoder knows no other level) with this code."""
ACTION = "board_guidance"
"""``live_decisions.action`` of a published change (the activity feed renders its note)."""
ISSUERS = {"ai_agent": "the AI agent", "controller": "the controller"}
CAVEAT_BY_SAFETY = {"passes_fire": THROUGH_FIRE_CAVEAT, "passes_near_fire": NEAR_FIRE_CAVEAT}
SYNC_TIMEOUT_S = 30
"""Local ``pymongo.timeout`` for one sync (a few queries and two batch writes)."""
WITHDRAW_GROUP_MIN = 3
"""At least this many withdrawals of non-board guidance in one PUT share one feed line."""
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(incident_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(incident_id, threading.Lock())


def _clock(minute: float | None) -> str:
    """Board clock text, as ``demo/format.ts`` ``simClock`` writes it: ``T+01:30``."""
    m = max(0, math.floor(minute or 0))
    return f"T+{m // 60:02d}:{m % 60:02d}"


def _route_json(route: dict[str, Any]) -> dict[str, Any]:
    """The board's route option as ``GuidanceRoute`` (integer ETA rounded up, distance to 10 m)."""
    return {
        "line": [[round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS)] for p in route["line"]],
        "via": list(route["via"])[:3],
        "distance_m": int(round(route["distance_m"] / ROUTE_DISTANCE_ROUND_M) * ROUTE_DISTANCE_ROUND_M),
        "eta_min": int(math.ceil(route["eta_min"])),
        "safety": route["safety"],
    }


def _issuer(order: dict[str, Any]) -> str:
    return ISSUERS.get(order.get("issued_by") or "", "the board")


def _moving(order: dict[str, Any], route: dict[str, Any] | None, index: DrillIndex, level: str) -> dict[str, Any] | None:
    destination = destination_json(index, order.get("destination_id"))
    if destination is None or not route or len(route.get("line") or ()) < 2:
        return None  # no route sent (an older page) or a destination the drill does not know: change nothing
    route_doc = _route_json(route)
    warning = order.get("status") == "warning"
    if warning:
        reason = (f"Evacuation warning from {_issuer(order)} on the simulated board: be ready to leave; "
                  "no evacuation order yet")
    elif level == "be_ready":
        start = order.get("start_minute")
        reason = f"Leave at {_clock(start)} on the simulated board clock (scheduled by {_issuer(order)})"
    else:
        reason = f"Evacuation ordered by {_issuer(order)} on the simulated board"
    return {
        "level": level,
        "destination": destination,
        "route": route_doc,
        "no_route": False,
        "reason": reason,
        "reason_code": WARNING if warning else "board_scheduled" if level == "be_ready" else "board_order",
        "caveat": CAVEAT_BY_SAFETY.get(route_doc["safety"]),
        "alternatives": [],
        "board_start_minute": order.get("start_minute") if level == "be_ready" and not warning else None,
    }


def target(order: dict[str, Any], route: dict[str, Any] | None, index: DrillIndex,
           latest: dict[str, Any] | None, restarted: bool = False) -> dict[str, Any] | None:
    """What the zone should be told for its board ``order`` given its ``latest`` guidance; None = no change.

    ``restarted``: ``latest`` came from an earlier board run (Reset board, a reload, a new landscape)."""
    status = order["status"]
    cleared = latest is not None and latest.get("reason_code") == ALL_CLEAR
    told = latest is not None and latest.get("level") != "none"
    if status == "lifted":
        if not told:
            return None  # nothing to lift (never ordered, or already withdrawn / lifted)
        return {"level": "none", "destination": None, "route": None, "no_route": False,
                "reason": f"All clear: the evacuation order for your zone has been lifted by {_issuer(order)} "
                          "on the simulated board. You may return home; drive carefully.",
                "reason_code": ALL_CLEAR, "caveat": None, "alternatives": [], "board_start_minute": None}
    if cleared and restarted:
        told = True  # a new board run withdraws the former all-clear too
    if status in ("leaving", "done"):
        return _moving(order, route, index, "evacuate_now")
    if status in ("scheduled", "warning"):
        return _moving(order, route, index, "be_ready")
    if status == "overrun":
        if not told and not order.get("destination_id"):
            return None
        return {"level": "evacuate_now", "destination": None, "route": None, "no_route": True,
                "reason": "Fire reached this zone on the simulated board", "reason_code": "board_overrun",
                "caveat": None, "alternatives": [], "board_start_minute": None}
    if not told:
        return None
    if restarted:
        reason = "The simulated board restarted: no evacuation order"
    elif latest.get("source") == SOURCE and latest.get("reason_code") == WARNING:
        reason = f"Evacuation warning withdrawn by {_issuer(order)} on the simulated board: no need to be ready to leave"
    elif latest.get("source") == SOURCE and latest.get("level") == "be_ready" and order.get("issued_by"):
        reason = f"Scheduled evacuation cancelled by {_issuer(order)} on the simulated board"
    else:
        reason = "No evacuation order on the simulated board"
    return {"level": "none", "destination": None, "route": None, "no_route": False, "reason": reason,
            "reason_code": "board_no_order", "caveat": None, "alternatives": [], "board_start_minute": None}


def _key(doc: dict[str, Any]) -> tuple[Any, ...]:
    """What makes a new version: source, level, no route, destination, road to leave by, scheduled start."""
    via = ((doc.get("route") or {}).get("via") or [None])[0]
    start = doc.get("board_start_minute") if doc.get("level") == "be_ready" else None
    return (doc.get("source"), doc.get("level"), bool(doc.get("no_route")),
            (doc.get("destination") or {}).get("id"), via, start)


IN_PLACE = ("route", "caveat", "reason", "reason_code", "issued_by", "destination")


def _feed_text(zone_label: str, doc: dict[str, Any], latest: dict[str, Any] | None) -> str:
    dest = (doc.get("destination") or {}).get("name") or ""
    road = ((doc.get("route") or {}).get("via") or [None])[0]
    dest = dest.split(" via ")[0].strip() or dest  # "Exit west via Hedstrom Way" -> "Exit west", as the phone shows it
    where = (f" via {road}" if road else "") + (f" to {dest}" if dest else "")
    level = doc["level"]
    if doc.get("reason_code") == ALL_CLEAR:
        what = "All clear, you may return"
    elif level == "none":
        reason = doc.get("reason") or ""
        what = "No order" + (" (scheduled evacuation cancelled)" if reason.startswith("Scheduled evacuation cancelled")
                             else " (evacuation warning withdrawn)" if reason.startswith("Evacuation warning withdrawn")
                             else " (board restarted)" if reason.startswith("The simulated board restarted") else "")
    elif doc.get("no_route"):
        what = "No open route, shelter in place"
    elif level == "be_ready" and doc.get("reason_code") == WARNING:
        what = f"Be ready to leave (evacuation warning, no order yet){where}"
    elif level == "be_ready":
        what = f"Be ready, leave at {_clock(doc.get('board_start_minute'))}{where}"
    else:
        rerouted = latest is not None and latest.get("source") == SOURCE and latest.get("level") == "evacuate_now" \
            and not latest.get("no_route")
        what = f"Leave now{where}" + (" (new route)" if rerouted else "")
    return f"Residents of {zone_label} told: {what}"


def _zone_label(index: DrillIndex, zone_id: str) -> str:
    zone = index.zones.get(zone_id)
    if ":" in zone_id and zone is not None:
        return zone.name  # census block-group ids are long; their names read better
    return zone_id


def _latest_by_zone(incident_id: str) -> dict[str, dict[str, Any]]:
    """Latest version per zone (any source), without its alternatives."""
    rows = col(GUIDANCE).aggregate([
        {"$match": {"incident_id": incident_id}},
        {"$sort": {"zone_id": 1, "version": -1}},
        {"$group": {"_id": "$zone_id", "doc": {"$first": "$$ROOT"}}},
        {"$project": {"doc.alternatives": 0}},
    ])
    return {row["_id"]: row["doc"] for row in rows}


def _insert_one(incident_id: str, zone_id: str, doc: dict[str, Any]) -> None:
    """Insert ``doc`` as the zone's next version, re-reading the version after a concurrent insert."""
    guidance = col(GUIDANCE)
    for attempt in range(2):
        latest = guidance.find_one({"incident_id": incident_id, "zone_id": zone_id}, {"version": 1},
                                   sort=[("version", -1)])
        doc["version"] = (latest["version"] if latest else 0) + 1
        doc.pop("_id", None)
        try:
            guidance.insert_one(doc)
            return
        except DuplicateKeyError:
            if attempt == 1:
                raise


def _insert_all(incident_id: str, docs: list[dict[str, Any]]) -> None:
    """One round trip for the usual case; a version taken meanwhile is retried on its own."""
    if not docs:
        return
    try:
        col(GUIDANCE).insert_many(docs, ordered=False)
    except BulkWriteError as exc:
        errors = exc.details.get("writeErrors", [])
        if not errors or any(e.get("code") != 11000 for e in errors):
            raise
        for e in errors:
            _insert_one(incident_id, docs[e["index"]]["zone_id"], docs[e["index"]])
    for d in docs:
        d.pop("_id", None)


def sync(incident_id: str, run_id: str, board_minute: float, zones: list[dict[str, Any]],
         routes: dict[str, dict[str, Any]], now: datetime) -> int:
    """Publish what each zone's board order tells its residents; returns how many versions were written.

    Called only by the lease holder's run-state PUT, so one console publishes. Idempotent: a PUT
    whose orders did not change writes nothing (at most an in-place route refresh). Reads the
    latest versions in one query and writes new ones in one batch (a fresh board withdrawing every
    zone must fit the request's MongoDB budget)."""
    try:
        index = get_index(incident_id)
    except Exception:  # noqa: BLE001 - an incident without a drill has no phones to tell
        return 0
    with _lock(incident_id), pymongo.timeout(SYNC_TIMEOUT_S):
        latest_by_zone = _latest_by_zone(incident_id)
        replay_at = report_replay_at(incident_id, now)
        base: dict[str, Any] = {"published_at": now, "approved_by": "controller", "proposal_id": f"board:{run_id}",
                                "source": SOURCE, "board_run_id": run_id, "board_minute": board_minute,
                                "evidence_class": "simulated"}
        if replay_at is not None:
            base["replay_at"] = replay_at  # the validator wants a date or nothing
        published: list[tuple[str, dict[str, Any], dict[str, Any] | None]] = []
        updated = 0
        for zone in zones:
            zone_id = zone["zone_id"]
            if zone_id not in index.zones:
                continue
            order = zone["order"]
            latest = latest_by_zone.get(zone_id)
            same_run = latest is not None and latest.get("source") == SOURCE and latest.get("board_run_id") == run_id
            if order.get("issued_by") is None and same_run:
                # The board's event log is capped: an old order's actor may have dropped out of it.
                order = {**order, "issued_by": latest.get("issued_by")}
            want = target(order, routes.get(zone_id), index, latest, restarted=latest is not None and not same_run
                          and latest.get("source") == SOURCE)
            if want is None:
                continue
            want["issued_by"] = order.get("issued_by")
            if latest is not None and _key({**want, "source": SOURCE}) == _key(latest):
                diff = {f: want[f] for f in IN_PLACE if latest.get(f) != want[f]}
                if diff:
                    col(GUIDANCE).update_one({"_id": latest["_id"]}, {"$set": diff})
                    updated += 1
                continue
            doc = {"incident_id": incident_id, "zone_id": zone_id, **want,
                   "version": (latest["version"] if latest else 0) + 1, **base}
            published.append((zone_id, doc, latest))
        _insert_all(incident_id, [d for _, d, _ in published])
        if published or updated:
            invalidate_guidance(incident_id)
        _log_feed(incident_id, index, published, now, replay_at)
        return len(published)


def withdraw_board(incident_id: str, run_id: str, now: datetime) -> int:
    """A new Studio run replaced the board (studio_fires.publish): withdraw every zone the previous
    board run told something, at once, so phones do not keep its orders until the new board's first
    run-state PUT. ``run_id`` names the replacement (it differs from every board run id), so each
    withdrawal reads "The simulated board restarted"; returns how many versions were written."""
    latest = _latest_by_zone(incident_id)
    zones = [{"zone_id": z, "order": {"status": "none"}} for z, d in latest.items()
             if d.get("source") == SOURCE and d.get("level") != "none"]
    if not zones:
        return 0
    return sync(incident_id, run_id, 0.0, zones, {}, now)


def _log_feed(incident_id: str, index: DrillIndex, published: list[tuple[str, dict[str, Any], dict[str, Any] | None]],
              now: datetime, replay_at: datetime | None) -> None:
    """One ``live_decisions`` line per published change; withdrawals of non-board guidance share one."""
    if not published:
        return
    stale = {z for z, d, l in published if d["level"] == "none" and (l or {}).get("source") != SOURCE}
    grouped = len(stale) >= WITHDRAW_GROUP_MIN
    entries = []
    for zone_id, doc, latest in published:
        if grouped and zone_id in stale:
            continue
        actor = doc.get("issued_by") or "board"
        entries.append((actor, _feed_text(_zone_label(index, zone_id), doc, latest)))
    if grouped:
        entries.append(("board", f"Residents of {len(stale)} zones told: No order (earlier guidance withdrawn; "
                                 "the simulated board has no order there)"))
    rows = [{"incident_id": incident_id, "at": now, "actor": actor, "action": ACTION, "report_ids": [],
             "proposal_id": None, "checkin_id": None, "note": note, "replay_at": replay_at}
            for actor, note in entries]
    col("live_decisions").insert_many(rows)
