"""Drill injects in the live API: storage, the drill-clock hook and the controller endpoints.

Rules (types, validation, status, geometry) are in ``livecore.injects``. Docs in ``live_injects``:
``{id, incident_id, type, params, at, status, actor, created_at}``; ``at`` and ``params.until`` are
drill time. Effects are read from the documents, so applying them is idempotent:

- ``apply_due`` (called where the snapshot is loaded) moves ``status`` with the drill clock and
  logs each change once in ``live_decisions`` (``inject_started``, ``inject_ended``);
- ``psap_reroute`` is read by ``groundrecord`` (the 911 stream of the zones is dropped);
- ``comms_outage`` is checked by ``refuse_if_no_signal`` before a phone report or check-in is stored;
- ``silent_closure`` and ``shelter_full`` are twin commands (``twin_service``), never reports;
- ``fire_jump`` is an overlay in the snapshot's fire estimate.

Everything here is simulated and labeled; nothing is sent to anyone.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from livecore import injects as rules
from livecore.geo import haversine_m, point_in_multipolygon
from rest_framework.response import Response

from .auth import Principal, live_view
from .common import ApiError, col, error, iso, json_body, new_id, ok, parse_iso, wall_now
from .drillcache import DrillIndex, get_index

log = logging.getLogger(__name__)

MAX_INJECTS = 60
ACTOR_MAX = 40
RETRY_AFTER_S = "60"


def _parse_time(value: Any, field: str) -> datetime:
    try:
        return parse_iso(value, field, "invalid_inject")
    except ApiError as exc:
        raise rules.InjectError(exc.detail) from exc


def load(incident_id: str) -> list[dict[str, Any]]:
    """All injects of the incident, ``at`` ascending."""
    return list(col("live_injects").find({"incident_id": incident_id}).sort([("at", 1), ("id", 1)]))


def _log(incident_id: str, action: str, note: str, now: datetime, actor: str = "inject") -> None:
    from .controller import log_decision  # local: controller imports state, which imports this module

    log_decision(incident_id, actor, action, now, note=note)


def _names(index: DrillIndex) -> dict[str, str]:
    names = {z.id: z.name for z in index.drill.zones}
    names.update({d.id: d.name for d in index.drill.destinations})
    names.update({seg: name for seg, name in index.segment_names.items() if name})
    return names


def apply_due(index: DrillIndex, incident_id: str, replay_now: datetime, wall: datetime) -> list[dict[str, Any]]:
    """Move each inject's stored status to its status at ``replay_now`` and log each change once.

    Returns the injects (with the new status). A status that goes back to ``scheduled`` (the
    drill clock was reset) is stored without a log entry."""
    docs = load(incident_id)
    names = _names(index)
    for doc in docs:
        status = rules.status_at(doc["type"], doc["at"], doc["params"], replay_now)
        if status == doc["status"]:
            continue
        # Compare-and-set: two overlapping polls log the change once.
        moved = col("live_injects").update_one({"id": doc["id"], "status": doc["status"]}, {"$set": {"status": status}})
        old, doc["status"] = doc["status"], status
        if moved.modified_count != 1 or status == "scheduled":
            continue
        # active -> ended is an end; scheduled -> ended passes both states and logs the start too.
        if status == "ended" and old == "scheduled":
            _log(incident_id, "inject_started", rules.label(doc["type"], doc["params"], names), wall)
        action = "inject_started" if status == "active" else "inject_ended"
        _log(incident_id, action, rules.label(doc["type"], doc["params"], names), wall)
    return docs


def inject_json(doc: dict[str, Any], index: DrillIndex) -> dict[str, Any]:
    """``DrillInject``: the stored inject plus ``label``, a map ``coord`` and ``zone_ids``."""
    params = {k: (iso(v) if isinstance(v, datetime) else v) for k, v in doc["params"].items()}
    coord = None
    kind = doc["type"]
    if kind == "silent_closure":
        line = index.segment_lines.get(doc["params"].get("segment_id"))
        coord = list(line[len(line) // 2]) if line else None
    elif kind == "shelter_full":
        dest = index.destinations.get(doc["params"].get("destination_id"))
        coord = [dest.coord[0], dest.coord[1]] if dest else None
    elif kind == "fire_jump":
        coord = doc["params"]["coord"]
    return {
        "id": doc["id"],
        "type": kind,
        "params": params,
        "at": iso(doc["at"]),
        "status": doc["status"],
        "actor": doc["actor"],
        "label": rules.label(kind, doc["params"], _names(index)),
        "evidence_class": "simulated",
        "coord": coord,
        "zone_ids": list(doc["params"].get("zone_ids", [])),
    }


def command_json(index: DrillIndex, docs: list[dict[str, Any]], replay_now: datetime) -> dict[str, Any]:
    """Fields the command poll adds: ``injects`` and the zones with no phone signal now."""
    return {
        "injects": [inject_json(d, index) for d in docs],
        "no_signal_zone_ids": sorted(no_signal_zones(docs, replay_now)),
    }


# ---- effects ----


def no_signal_zones(docs: list[dict[str, Any]], replay_now: datetime) -> set[str]:
    windows = rules.zone_windows(docs, "comms_outage")
    return {zone for zone, w in windows.items() if rules.in_window(w, replay_now)}


def psap_windows(docs: list[dict[str, Any]] | None) -> dict[str, list[rules.Window]]:
    return rules.zone_windows(docs or [], "psap_reroute")


def zone_of(index: DrillIndex, coord: Any) -> str | None:
    if not (isinstance(coord, (list, tuple)) and len(coord) == 2):
        return None
    point = (float(coord[0]), float(coord[1]))
    for zone in index.zones.values():
        if point_in_multipolygon(point, zone.geometry):
            return zone.id
    return None


def refuse_if_no_signal(
    incident_id: str, principal: Principal, wall: datetime, *, zone_id: str | None = None, coord: Any = None
) -> Response | None:
    """A 503 ``no_signal`` when a civilian device declares a zone (``zone_id``, or the zone holding
    ``coord``) that has no phone signal at the drill's time; else None. Mimics a dead network: the
    phone's offline outbox keeps the item and retries. Responders keep their radio and are exempt."""
    if principal.role != "civilian":
        return None
    docs = [d for d in load(incident_id) if d["type"] == "comms_outage"]
    if not docs:
        return None
    from .state import clock_from, drill_doc  # local: state imports this module

    index = get_index(incident_id)
    replay_now = clock_from(drill_doc(incident_id), index, wall).replay_now
    dead = no_signal_zones(docs, replay_now)
    if not dead:
        return None
    zone = zone_id or zone_of(index, coord)
    if zone not in dead:
        return None
    response = error(503, "no_signal", "Drill: no phone signal in this zone. The item stays on the phone and is sent later.")
    response["Retry-After"] = RETRY_AFTER_S
    return response


_segment_choices: dict[int, list[dict[str, Any]]] = {}
SEGMENT_CHOICES = 150
SEGMENT_MIN_M = 1500.0


def segment_choices(index: DrillIndex) -> list[dict[str, Any]]:
    """Longest named road segments for the console's silent-closure picker (``{id, name, length_m}``)."""
    cached = _segment_choices.get(id(index))
    if cached is None:
        rows = []
        for seg, line in index.segment_lines.items():
            name = index.segment_names.get(seg)
            if not name or name.startswith("unnamed"):
                continue
            length = sum(haversine_m(a, b) for a, b in zip(line, line[1:]))
            if length >= SEGMENT_MIN_M:
                rows.append({"id": seg, "name": name, "length_m": int(round(length, -1))})
        rows.sort(key=lambda r: (-r["length_m"], r["id"]))
        cached = _segment_choices[id(index)] = sorted(rows[:SEGMENT_CHOICES], key=lambda r: (r["name"], r["id"]))
    return cached


# ---- endpoints ----


def _create(incident_id: str, principal: Principal, body: dict[str, Any]) -> dict[str, Any]:
    from .state import clock_from, drill_doc

    index = get_index(incident_id)
    now = wall_now()
    clock = clock_from(drill_doc(incident_id), index, now)
    try:
        at_raw = body.get("at")
        at = clock.replay_now.replace(microsecond=0) if at_raw is None else _parse_time(at_raw, "at")
        drill = index.drill
        if not drill.clock_start <= at < drill.clock_end:
            raise rules.InjectError("`at` must be within the drill clock.")
        params = rules.normalize_params(
            body.get("type"), body.get("params"), at,
            zones=index.zones.keys(),
            destinations={d.id: d.kind for d in drill.destinations},
            segments=index.segment_lines.keys(),
            parse_time=_parse_time,
        )
    except rules.InjectError as exc:
        raise ApiError(400, "invalid_inject", str(exc)) from exc
    actor = body.get("actor", "controller")
    if not isinstance(actor, str) or not actor.strip() or len(actor) > ACTOR_MAX:
        raise ApiError(400, "invalid_inject", f"`actor` must be a string of at most {ACTOR_MAX} characters.")
    if col("live_injects").count_documents({"incident_id": incident_id}) >= MAX_INJECTS:
        raise ApiError(409, "conflict", f"At most {MAX_INJECTS} injects per incident; delete some first.")
    doc = {
        "id": new_id("inj_"),
        "incident_id": incident_id,
        "type": body["type"],
        "params": params,
        "at": at,
        "status": "scheduled",  # apply_due moves it and logs the start
        "actor": actor.strip(),
        "created_at": now,
    }
    col("live_injects").insert_one(doc)
    _log(incident_id, "inject_created", rules.label(doc["type"], params, _names(index)), now, doc["actor"])
    if at <= clock.replay_now:
        apply_due(index, incident_id, clock.replay_now, now)  # logs the start of a trigger-now inject
        doc["status"] = col("live_injects").find_one({"id": doc["id"]})["status"]
    return inject_json(doc, index)


def _delete(incident_id: str, inject_id: str | None) -> Response:
    doc = col("live_injects").find_one_and_delete({"incident_id": incident_id, "id": inject_id}) if inject_id else None
    if doc is None:
        return error(404, "not_found", "Unknown inject.")
    _log(incident_id, "inject_deleted", rules.label(doc["type"], doc["params"], _names(get_index(incident_id))), wall_now(),
         "controller")
    return ok({"deleted": inject_id})


@live_view(["GET", "POST", "DELETE"], roles=["controller"])
def incident_injects(request, incident_id: str, principal: Principal):
    index = get_index(incident_id)
    if request.method == "DELETE":
        return _delete(incident_id, request.query_params.get("id"))
    if request.method == "GET":
        from .state import clock_from, drill_doc

        now = wall_now()
        clock = clock_from(drill_doc(incident_id), index, now)
        docs = apply_due(index, incident_id, clock.replay_now, now)
        return ok({"injects": [inject_json(d, index) for d in docs], "replay_now": iso(clock.replay_now),
                   "choices": {"segments": segment_choices(index)}})
    created = _create(incident_id, principal, json_body(request, "invalid_inject"))
    return ok({"inject": created}, status=201)


@live_view(["DELETE"], roles=["controller"])
def delete_inject(request, incident_id: str, inject_id: str, principal: Principal):
    return _delete(incident_id, inject_id)
