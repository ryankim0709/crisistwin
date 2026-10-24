"""Controller event stream: ``GET incidents/{id}/events?since=<cursor>`` (docs/live-reports.md "Event stream").

Merges, in time order, what changed in the live collections since a cursor, so an agent (ADR 0030
"Controller surface for the orchestrator") need not diff ``command`` polls. Read only; no new
collection. Documents keep only their current state (a report, check-in or task is updated in
place), so an event carries the document's state now plus the ``change`` that happened at ``at``.

Delivery is at least once: the cursor never moves past ``now - EVENT_SETTLE_MS``, because a
document can be written with a timestamp taken a few seconds before the write (a twin-scored
replan takes ~5-7 s). Events in that window are sent again on the next poll; clients dedupe by
``key``, which is stable.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from livecore import drill as drillmod

from .auth import Principal, live_view
from .common import col, error, iso, ok, wall_now
from .drillcache import get_index
from .state import drill_doc

EVENTS_PAGE_DEFAULT = 200
EVENTS_PAGE_MAX = 500
EVENT_SETTLE_MS = 10_000
"""The cursor stays this far behind the server clock; later events may be delivered twice."""
NOTE_CHARS = 160
CHANGES_IN_EVENT = 12
"""A proposal event lists at most this many of its zone changes (``n_changes`` has the total)."""


def _ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return int(value.timestamp() * 1000)


def _short(text: Any) -> str | None:
    if not isinstance(text, str) or not text:
        return None
    return text if len(text) <= NOTE_CHARS else text[: NOTE_CHARS - 1] + "…"


def parse_cursor(raw: str | None, now: datetime) -> tuple[int, str] | None:
    """``None`` (from the start), ``now`` (start at the server clock), or ``<ms>:<key>`` from ``next_cursor``."""
    if raw is None or raw == "":
        return (-1, "")
    if raw == "now":
        return (_ms(now) - EVENT_SETTLE_MS, "")
    millis, _, key = raw.partition(":")
    if not millis.lstrip("-").isdigit():
        return None
    return (int(millis), key)


def encode_cursor(position: tuple[int, str]) -> str:
    return f"{position[0]}:{position[1]}"


class _Clock:
    """Drill time at a wall time, from the current drill document: an estimate for events whose
    document has no stored drill time (wrong if the speed changed or the drill was reset since)."""

    def __init__(self, incident_id: str) -> None:
        self.doc = drill_doc(incident_id) or {}
        self.end = get_index().drill.clock_end

    def at(self, wall: datetime) -> datetime | None:
        started = self.doc.get("started_at")
        if started is None:
            return None
        started = started if started.tzinfo else started.replace(tzinfo=UTC)
        wall = wall if wall.tzinfo else wall.replace(tzinfo=UTC)
        if wall < started:
            return None
        start = self.doc["replay_start"]
        start = start if start.tzinfo else start.replace(tzinfo=UTC)
        return drillmod.replay_now(start, started, wall, float(self.doc.get("speed", 1)), self.end)


def _event(at: datetime, type_: str, id_: str, replay_at: datetime | None, **fields: Any) -> dict[str, Any]:
    ms = _ms(at)
    return {
        "key": f"{ms}:{type_}:{id_}",
        "at": iso(at),
        "replay_at": iso(replay_at),
        "type": type_,
        "id": id_,
        **fields,
        "_pos": (ms, f"{type_}:{id_}"),
    }


def _report_events(incident_id: str, since: datetime) -> Iterable[dict[str, Any]]:
    for d in col("live_reports").find({"incident_id": incident_id, "updated_at": {"$gte": since}}):
        road = d.get("road_ref") or {}
        received = d.get("received_at")
        yield _event(
            d["updated_at"], "report", d["id"], d.get("replay_at"),
            change="new" if received is not None and _ms(received) == _ms(d["updated_at"]) else "updated",
            kind=d["kind"], status=d["status"], severity=d.get("severity"),
            evidence_class=d.get("evidence_class"), reporter_role=(d.get("reporter") or {}).get("role"),
            segment_id=road.get("segment_id"), road_name=road.get("name"),
            destination_id=d.get("destination_id"), coord=(d.get("location") or {}).get("coord"),
            task_id=d.get("task_id"), note=_short(d.get("note")),
        )


def _decision_events(incident_id: str, since: datetime, clock: _Clock) -> Iterable[dict[str, Any]]:
    for d in col("live_decisions").find({"incident_id": incident_id, "at": {"$gte": since}}):
        yield _event(
            d["at"], "decision", f"dec_{d['_id']}", clock.at(d["at"]),
            actor=d["actor"], action=d["action"], report_ids=d.get("report_ids") or [],
            proposal_id=d.get("proposal_id"), checkin_id=d.get("checkin_id"), note=_short(d.get("note")),
        )


def _change_summary(change: dict[str, Any]) -> dict[str, Any]:
    to = change.get("to") or {}
    route = to.get("route") or {}
    return {
        "zone_id": change.get("zone_id"),
        "kind": change.get("kind"),
        "from_level": (change.get("from") or {}).get("level"),
        "to_level": to.get("level"),
        "to_destination_id": (to.get("destination") or {}).get("id"),
        "to_via": route.get("via"),
        "to_eta_min": route.get("eta_min"),
        "no_route": to.get("no_route"),
    }


def _proposal_events(incident_id: str, since: datetime) -> Iterable[dict[str, Any]]:
    query = {"incident_id": incident_id, "$or": [{"created_at": {"$gte": since}}, {"decided_at": {"$gte": since}}]}
    for d in col("live_proposals").find(query, {"_id": 0}):
        controller = d.get("controller") or {}
        common = {"status": d["status"], "policy": d.get("policy"), "parent_id": d.get("parent_id")}
        created, decided = d["created_at"], d.get("decided_at")
        if _ms(created) >= _ms(since):
            changes = d.get("changes") or []
            yield _event(
                created, "proposal", d["id"], d.get("replay_at"), change="created", **common,
                causes=d.get("causes") or [], controller=controller.get("id"),
                controller_fallback=controller.get("fallback"), n_changes=len(changes),
                changes=[_change_summary(c) for c in changes[:CHANGES_IN_EVENT]], n_tasks=len(d.get("tasks") or []),
            )
        # An auto-approved part is decided as it is created: one event is enough.
        if decided is not None and _ms(decided) >= _ms(since) and _ms(decided) != _ms(created):
            yield _event(
                decided, "proposal", d["id"], d.get("decided_replay_at"), change="decided", **common,
                decided_by=d.get("decided_by"), note=_short(d.get("note")),
            )


def _guidance_events(incident_id: str, since: datetime) -> Iterable[dict[str, Any]]:
    for d in col("live_guidance").find({"incident_id": incident_id, "published_at": {"$gte": since}}):
        route = d.get("route") or {}
        yield _event(
            d["published_at"], "guidance", f"{d['zone_id']}@v{d['version']}", d.get("replay_at"),
            zone_id=d["zone_id"], version=d["version"], level=d["level"],
            destination_id=(d.get("destination") or {}).get("id"), via=route.get("via"),
            eta_min=route.get("eta_min"), no_route=d.get("no_route", False), reason_code=d.get("reason_code"),
            approved_by=d.get("approved_by"), proposal_id=d.get("proposal_id"),
        )


def _checkin_events(incident_id: str, since: datetime, clock: _Clock) -> Iterable[dict[str, Any]]:
    query = {"incident_id": incident_id, "$or": [{"at": {"$gte": since}}, {"help.updated_at": {"$gte": since}}]}
    for d in col("live_checkins").find(query):
        help_ = d.get("help") if d["status"] == "need_help" else None
        if _ms(d["at"]) >= _ms(since):
            yield _event(
                d["at"], "checkin", d["id"], d.get("replay_at"),
                status=d["status"], zone_id=d.get("zone_id"), role=d.get("role"),
                coord=d.get("coord"), help_status=(help_ or {}).get("status"),
            )
        updated = (d.get("help") or {}).get("updated_at")
        if updated is not None and _ms(updated) >= _ms(since) and _ms(updated) != _ms(d["at"]):
            h = d["help"]
            yield _event(
                updated, "help", d["id"], clock.at(updated),
                status=h.get("status"), assignee=h.get("assignee"), task_id=h.get("task_id"), zone_id=d.get("zone_id"),
            )


TASK_TRANSITIONS = (("created_at", "created"), ("accepted_at", "accepted"), ("closed_at", "closed"))


def _task_events(incident_id: str, since: datetime, clock: _Clock) -> Iterable[dict[str, Any]]:
    query = {"incident_id": incident_id, "$or": [{f: {"$gte": since}} for f, _ in TASK_TRANSITIONS]}
    for d in col("live_tasks").find(query):
        target = d.get("target") or {}
        for field, change in TASK_TRANSITIONS:
            at = d.get(field)
            if at is None or _ms(at) < _ms(since):
                continue
            yield _event(
                at, "task", d["id"], clock.at(at), change=change,
                kind=d.get("kind", "verify"), status=d["status"], assignee=d.get("assignee"),
                segment_id=target.get("segment_id"), coord=target.get("coord"),
                report_ids=d.get("report_ids") or [], checkin_id=d.get("checkin_id"), note=_short(d.get("note")),
            )


def collect(incident_id: str, position: tuple[int, str], now: datetime, limit: int) -> dict[str, Any]:
    """Events after ``position`` in (time, key) order, at most ``limit``, plus ``next_cursor`` and ``more``."""
    since = datetime.fromtimestamp(max(position[0], 0) / 1000, tz=UTC)
    clock = _Clock(incident_id)
    events = [
        e
        for source in (
            _report_events(incident_id, since),
            _decision_events(incident_id, since, clock),
            _proposal_events(incident_id, since),
            _guidance_events(incident_id, since),
            _checkin_events(incident_id, since, clock),
            _task_events(incident_id, since, clock),
        )
        for e in source
        if e["_pos"] > position
    ]
    events.sort(key=lambda e: e["_pos"])
    more = len(events) > limit
    page = events[:limit]
    settle = (_ms(now) - EVENT_SETTLE_MS, "")
    if not page:
        next_position = position
    elif more:
        next_position = page[-1]["_pos"]  # a full page always advances, or a busy window would loop
    else:
        next_position = max(position, min(page[-1]["_pos"], settle))
    for e in page:
        del e["_pos"]
    return {"events": page, "next_cursor": encode_cursor(next_position), "more": more}


@live_view(["GET"], roles=["controller"])
def incident_events(request, incident_id: str, principal: Principal):
    now = wall_now()
    position = parse_cursor(request.query_params.get("since"), now)
    if position is None:
        return error(400, "invalid_request", "`since` must be `now` or a cursor from `next_cursor`.")
    raw_limit = request.query_params.get("limit", str(EVENTS_PAGE_DEFAULT))
    if not raw_limit.isdigit() or not 1 <= int(raw_limit) <= EVENTS_PAGE_MAX:
        return error(400, "invalid_request", f"`limit` must be an integer in 1..{EVENTS_PAGE_MAX}.")
    if request.query_params.get("since") == "now":
        # A starting point only: the settle window's events come with the next poll.
        body = {"events": [], "next_cursor": encode_cursor(position), "more": False}
    else:
        body = collect(incident_id, position, now, int(raw_limit))
    return ok({"incident_id": incident_id, "generated_at": iso(now), **body})
