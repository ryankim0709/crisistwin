"""HTTP endpoints of the live API, v1 and v2 (docs/live-reports.md). Base path /api/live/."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from livecore.drill import DEFAULT_REPLAY_START, MAX_DRILL_SPEED
from livecore.geo import haversine_m
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from rest_framework.response import Response

from . import controller, twin_service
from .auth import Principal, client_ip, issue_token, live_view, rate_limited, secret_matches
from .common import (
    ApiError,
    col,
    error,
    iso,
    json_body,
    new_id,
    ok,
    optional_str,
    parse_coord,
    parse_iso,
    wall_now,
)
from .drillcache import get_index, snap_to_segment
from .state import (
    checkin_json,
    clock_from,
    current_guidance,
    drill_doc,
    drill_short_json,
    drill_state_json,
    fire_json,
    guidance_json,
    incident_json,
    load_public,
    load_snapshot,
    proposal_json,
    public_item_json,
    report_json,
    report_replay_at,
    responder_tasks,
    road_status_json,
    task_json,
)

REPORT_KINDS = frozenset(
    {
        "road_blocked",
        "road_passable",
        "heavy_traffic",
        "fire_seen",
        "heavy_smoke",
        "hazard_down",
        "shelter_full",
        "help_needed",
    }
)
ROAD_KINDS = frozenset({"road_blocked", "road_passable", "heavy_traffic"})
"""Kinds that snap to a road segment."""
SEVERITIES = frozenset({"full", "partial", "slow"})
SHELTER_FULL_DESTINATION_KINDS = frozenset({"shelter", "temporary_refuge"})
"""Destination kinds that can fill up; an exit cannot."""
TRIAGE_ACTIONS = {"confirm": "confirmed", "dismiss": "dismissed", "resolve": "resolved", "merge": "dismissed"}
REPLAN_CAUSE_ON_CONFIRM = {"road_blocked": "road_block", "fire_seen": "fire"}
CHECKIN_STATUSES = frozenset({"out", "need_help", "staying"})
PROMPT_KINDS = frozenset({"road_blocked", "road_passable", "hazard_down"})
PROMPT_RADIUS_M = 1000.0
"""``prompts`` returns public items within this distance of ``near``."""
MAX_OBSERVED_FUTURE_S = 600
"""Reports observed more than this far in the server's future are rejected (device clock skew)."""
REPORTS_PAGE_LIMIT = 500
COMMAND_REPORTS_LIMIT = 500
COMMAND_TASKS_LIMIT = 500
MAX_REPORT_IDS = 50
NOTE_MAX_CHARS = 500
RESPONDER_LOCATION_TTL_S = 900
DEVICE_ISSUE_LIMIT_PER_HOUR = 20
JOIN_ATTEMPTS_PER_HOUR = 20
CIVILIAN_REPORTS_PER_MIN = 6
CIVILIAN_REPORTS_PER_HOUR = 60
REPORTS_PER_IP_PER_MIN = 30
CHECKINS_PER_MIN = 10


def _bool_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# ---- v1: tokens ----


@live_view(["POST"], auth=False)
def devices(request, principal: None):
    if rate_limited(f"devices:{client_ip(request)}", DEVICE_ISSUE_LIMIT_PER_HOUR, 3600):
        return error(429, "rate_limited", "Too many devices from this network. Try again later.")
    return ok(issue_token("civilian", "dev_", None), status=201)


@live_view(["POST"], auth=False)
def join(request, incident_id: str, principal: None):
    if rate_limited(f"join:{client_ip(request)}", JOIN_ATTEMPTS_PER_HOUR, 3600):
        return error(429, "rate_limited", "Too many join attempts. Try again later.")
    body = json_body(request)
    code = body.get("invite_code")
    if not isinstance(code, str) or not secret_matches(code.strip(), "LIVE_INVITE_CODE"):
        return error(403, "forbidden", "Invalid invite code.")
    return ok(issue_token("responder", "rsp_", incident_id), status=201)


# ---- v1: reports ----


def _validate_report(body: dict[str, Any], incident_id: str) -> dict[str, Any]:
    code = "invalid_report"
    try:
        client_id = str(uuid.UUID(str(body.get("client_id"))))
    except ValueError as exc:
        raise ApiError(400, code, "`client_id` must be a UUID.") from exc
    if body.get("incident_id") not in (None, incident_id):
        raise ApiError(400, code, "`incident_id` does not match the path.")
    kind = body.get("kind")
    if kind not in REPORT_KINDS:
        raise ApiError(400, code, f"`kind` must be one of {', '.join(sorted(REPORT_KINDS))}.")
    severity = body.get("severity")
    if severity is not None and severity not in SEVERITIES:
        raise ApiError(400, code, "`severity` must be full, partial, slow or null.")
    location = body.get("location")
    if not isinstance(location, dict):
        raise ApiError(400, code, "`location` must be an object with `coord`.")
    coord = parse_coord(location.get("coord"), "location.coord", code)
    accuracy = location.get("accuracy_m")
    if accuracy is not None and (not _bool_number(accuracy) or accuracy < 0):
        raise ApiError(400, code, "`location.accuracy_m` must be a nonnegative number or null.")
    heading = body.get("heading_deg")
    if heading is not None and (not _bool_number(heading) or not 0 <= heading <= 360):
        raise ApiError(400, code, "`heading_deg` must be 0..360 or null.")
    destination_id = optional_str(body, "destination_id", code, 200)
    if kind == "shelter_full" and destination_id is None:
        raise ApiError(400, code, "`shelter_full` needs `destination_id`.")
    destinations = get_index().destinations
    if destination_id is not None and destination_id not in destinations:
        raise ApiError(400, code, "Unknown `destination_id`.")
    if kind == "shelter_full" and destinations[destination_id].kind not in SHELTER_FULL_DESTINATION_KINDS:
        raise ApiError(400, code, "`shelter_full` applies only to a shelter or temporary refuge.")
    task_id = optional_str(body, "task_id", code, 100)
    observed_at = parse_iso(body.get("observed_at"), "observed_at", code)
    if observed_at > wall_now() + timedelta(seconds=MAX_OBSERVED_FUTURE_S):
        raise ApiError(400, code, "`observed_at` is in the future.")
    return {
        "client_id": client_id,
        "kind": kind,
        "severity": severity,
        "location": {"coord": [coord[0], coord[1]], "accuracy_m": float(accuracy) if accuracy is not None else None},
        "heading_deg": float(heading) if heading is not None else None,
        "destination_id": destination_id,
        "task_id": task_id,
        "observed_at": observed_at,
        "note": optional_str(body, "note", code, NOTE_MAX_CHARS),
    }


def _refresh_corroboration(incident_id: str) -> None:
    """Mark unverified reports in a public, not controller-confirmed item as corroborated."""
    now = wall_now()
    _, _, items, _ = load_public(incident_id, now, get_index())
    reports = col("live_reports")
    for item in items:
        if item.controller_confirmed:
            continue
        status = "responder_confirmed" if item.responder_reports > 0 else "corroborated"
        reports.update_many(
            {"incident_id": incident_id, "id": {"$in": list(item.report_ids)}, "status": "unverified"},
            {"$set": {"status": status, "updated_at": now}},
        )


def _answer_task(principal: Principal, incident_id: str, task_id: str, report_id: str, now) -> None:
    if principal.role == "civilian":
        raise ApiError(403, "forbidden", "Only responders answer check tasks.")
    task = col("live_tasks").find_one({"id": task_id, "incident_id": incident_id})
    if task is None:
        raise ApiError(400, "invalid_report", "Unknown `task_id`.")
    query: dict[str, Any] = {"id": task_id, "status": {"$in": ["open", "accepted"]}}
    if principal.role == "responder":
        query["assignee"] = {"$in": [None, principal.party_key]}
    col("live_tasks").update_one(
        query,
        {
            "$set": {
                "status": "done",
                "assignee": task.get("assignee") or principal.party_key,
                "answer": {"report_id": report_id, "at": now},
                "closed_at": now,
            }
        },
    )


def _submit_report(request, incident_id: str, principal: Principal) -> Response:
    body = json_body(request, "invalid_report")
    fields = _validate_report(body, incident_id)
    reports = col("live_reports")
    existing = reports.find_one({"incident_id": incident_id, "client_id": fields["client_id"]})
    if existing is not None:
        return ok({"report": report_json(existing)})
    if principal.role == "civilian" and (
        rate_limited(f"rpt-min:{principal.party_key}", CIVILIAN_REPORTS_PER_MIN, 60)
        or rate_limited(f"rpt-hour:{principal.party_key}", CIVILIAN_REPORTS_PER_HOUR, 3600)
        or rate_limited(f"rpt-ip:{client_ip(request)}", REPORTS_PER_IP_PER_MIN, 60)
    ):
        return error(429, "rate_limited", "Too many reports. Try again in a minute.")
    index = get_index()
    road_ref = None
    if fields["kind"] in ROAD_KINDS:
        snapped = snap_to_segment(index, tuple(fields["location"]["coord"]))
        if snapped is not None:
            segment_id, snap_m = snapped
            road_ref = {
                "segment_id": segment_id,
                "name": index.segment_names.get(segment_id) or "Unnamed road",
                "snap_m": round(snap_m, 1),
            }
    now = wall_now()
    doc = {
        "id": new_id("rpt_"),
        "client_id": fields["client_id"],
        "incident_id": incident_id,
        "reporter": {"role": principal.role, "party_key": principal.party_key},
        "kind": fields["kind"],
        "severity": fields["severity"],
        "location": fields["location"],
        "heading_deg": fields["heading_deg"],
        "road_ref": road_ref,
        "destination_id": fields["destination_id"],
        "task_id": fields["task_id"],
        "observed_at": fields["observed_at"],
        "received_at": now,
        "note": fields["note"],
        "status": "unverified",
        "evidence_class": "field_report",
        "replay_at": report_replay_at(incident_id, now),
        "updated_at": now,
    }
    if fields["task_id"]:
        _answer_task(principal, incident_id, fields["task_id"], doc["id"], now)
    try:
        reports.insert_one(doc)
    except DuplicateKeyError:
        existing = reports.find_one({"incident_id": incident_id, "client_id": fields["client_id"]})
        if existing is None:
            raise
        return ok({"report": report_json(existing)})
    if fields["kind"] != "help_needed":
        _refresh_corroboration(incident_id)
    stored = reports.find_one({"id": doc["id"]}) or doc
    return ok({"report": report_json(stored)}, status=201)


def _encode_cursor(doc: dict[str, Any]) -> str:
    return f"{int(doc['updated_at'].timestamp() * 1000)}:{doc['id']}"


def _list_reports(request, incident_id: str) -> Response:
    since = request.query_params.get("since")
    query: dict[str, Any] = {"incident_id": incident_id}
    if since:
        millis, _, last_id = since.partition(":")
        if not millis.isdigit():
            return error(400, "invalid_request", "`since` must be a cursor from `next_cursor`.")
        at = datetime.fromtimestamp(int(millis) / 1000, tz=UTC)
        query["$or"] = [{"updated_at": {"$gt": at}}, {"updated_at": at, "id": {"$gt": last_id}}]
    docs = list(col("live_reports").find(query).sort([("updated_at", 1), ("id", 1)]).limit(REPORTS_PAGE_LIMIT))
    next_cursor = _encode_cursor(docs[-1]) if docs else (since or "0:")
    return ok({"reports": [report_json(d) for d in docs], "next_cursor": next_cursor})


@live_view(["GET", "POST"])
def incident_reports(request, incident_id: str, principal: Principal):
    if request.method == "POST":
        return _submit_report(request, incident_id, principal)
    if principal.role not in ("responder", "controller"):
        return error(403, "forbidden", "Only responders and controllers read all reports.")
    return _list_reports(request, incident_id)


@live_view(["GET"])
def my_reports(request, principal: Principal):
    docs = col("live_reports").find({"reporter.party_key": principal.party_key}).sort("received_at", -1).limit(200)
    return ok({"reports": [report_json(d) for d in docs]})


@live_view(["POST"], roles=["controller"])
def triage(request, report_id: str, principal: Principal):
    body = json_body(request)
    action = body.get("action")
    if action not in TRIAGE_ACTIONS:
        return error(400, "invalid_request", "`action` must be confirm, dismiss, merge or resolve.")
    note = optional_str(body, "note", "invalid_request", NOTE_MAX_CHARS)
    reports = col("live_reports")
    report = reports.find_one({"id": report_id})
    if report is None:
        return error(404, "not_found", "Unknown report.")
    now = wall_now()
    update: dict[str, Any] = {"status": TRIAGE_ACTIONS[action], "updated_at": now}
    report_ids = [report_id]
    if action == "merge":
        into = body.get("into")
        if not isinstance(into, str) or into == report_id:
            return error(400, "invalid_request", "`merge` needs `into`, another report id.")
        if reports.count_documents({"id": into, "incident_id": report["incident_id"]}, limit=1) == 0:
            return error(400, "invalid_request", "Unknown `into` report.")
        update["merged_into"] = into
        report_ids.append(into)
    stored = reports.find_one_and_update(
        {"id": report_id}, {"$set": update}, return_document=ReturnDocument.AFTER
    )
    controller.log_decision(report["incident_id"], "controller", action, now, report_ids=report_ids, note=note)
    response: dict[str, Any] = {"report": report_json(stored)}
    cause = REPLAN_CAUSE_ON_CONFIRM.get(report["kind"]) if action == "confirm" else None
    if cause:
        pending, auto = controller.replan(load_snapshot(report["incident_id"], now), [cause])
        response["replan"] = {
            "proposal": proposal_json(pending) if pending else None,
            "auto_approved": proposal_json(auto) if auto else None,
        }
    return ok(response)


@live_view(["GET"], roles=["responder", "controller"])
def road_state(request, incident_id: str, principal: Principal):
    _, _, _, state = load_public(incident_id, wall_now(), get_index())
    return ok({"items": [road_status_json(s) for s in state]})


@live_view(["GET"])
def public_map(request, incident_id: str, principal: Principal):
    _, _, items, _ = load_public(incident_id, wall_now(), get_index())
    return ok({"items": [public_item_json(i, principal.role == "controller") for i in items]})


@live_view(["GET"])
def prompts(request, incident_id: str, principal: Principal):
    near_raw = request.query_params.get("near", "")
    try:
        near = parse_coord([float(v) for v in near_raw.split(",")], "near", "invalid_request")
    except ValueError:
        return error(400, "invalid_request", "`near` must be lon,lat.")
    _, _, items, _ = load_public(incident_id, wall_now(), get_index())
    nearby = [i for i in items if i.kind in PROMPT_KINDS and haversine_m(near, i.coord) <= PROMPT_RADIUS_M]
    nearby.sort(key=lambda i: haversine_m(near, i.coord))
    return ok({"items": [public_item_json(i) for i in nearby]})


# ---- v1/v2: tasks ----


@live_view(["POST"], roles=["controller"])
def create_task(request, incident_id: str, principal: Principal):
    body = json_body(request)
    code = "invalid_request"
    assignee = body.get("assignee")
    if assignee is not None and (not isinstance(assignee, str) or not assignee.startswith("rsp_")):
        return error(400, code, "`assignee` must be a responder party_key or null.")
    target = body.get("target")
    if not isinstance(target, dict):
        return error(400, code, "`target` must be an object with `segment_id` and/or `coord`.")
    segment_id = target.get("segment_id")
    coord = parse_coord(target["coord"], "target.coord", code) if target.get("coord") is not None else None
    index = get_index()
    if segment_id is not None:
        if not isinstance(segment_id, str) or segment_id not in index.segment_lines:
            return error(400, code, "Unknown `target.segment_id`.")
        if coord is None:
            line = index.segment_lines[segment_id]
            coord = line[len(line) // 2]
    if coord is None:
        return error(400, code, "`target` needs `segment_id` or `coord`.")
    report_ids = body.get("report_ids", [])
    if (
        not isinstance(report_ids, list)
        or len(report_ids) > MAX_REPORT_IDS
        or not all(isinstance(r, str) for r in report_ids)
    ):
        return error(400, code, f"`report_ids` must be a list of at most {MAX_REPORT_IDS} ids.")
    note = optional_str(body, "note", code, NOTE_MAX_CHARS)
    now = wall_now()
    task = controller.create_task(
        incident_id, assignee, {"segment_id": segment_id, "coord": [coord[0], coord[1]]}, report_ids, note, now
    )
    controller.log_decision(incident_id, "controller", "task_create", now, report_ids=report_ids, note=note)
    return ok({"task": task_json(task)}, status=201)


@live_view(["GET"], roles=["responder", "controller"])
def my_tasks(request, principal: Principal):
    incident_id = principal.incident_id or controller_incident()
    if principal.role == "controller":
        docs = col("live_tasks").find({"status": {"$in": ["open", "accepted"]}}).sort("created_at", -1).limit(500)
    else:
        docs = responder_tasks(incident_id, principal.party_key)
    return ok({"tasks": [task_json(d) for d in docs]})


def controller_incident() -> str:
    return get_index().drill.incident_id


@live_view(["POST"], roles=["responder", "controller"])
def update_task(request, task_id: str, principal: Principal):
    body = json_body(request)
    status = body.get("status")
    note = optional_str(body, "note", "invalid_request", NOTE_MAX_CHARS)
    tasks = col("live_tasks")
    task = tasks.find_one({"id": task_id})
    if task is None or (principal.role == "responder" and principal.incident_id not in (None, task["incident_id"])):
        return error(404, "not_found", "Unknown task.")
    now = wall_now()
    if status == "accepted":
        if principal.role != "responder":
            return error(403, "forbidden", "Only responders accept tasks.")
        updated = tasks.find_one_and_update(
            {"id": task_id, "status": "open", "assignee": {"$in": [None, principal.party_key]}},
            {"$set": {"status": "accepted", "assignee": principal.party_key, "accepted_at": now}},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            current = tasks.find_one({"id": task_id})
            if current and current["status"] == "accepted" and current.get("assignee") == principal.party_key:
                return ok({"task": task_json(current)})  # a retried accept by the same responder
            return error(409, "conflict", "The task was taken by someone else or is closed.")
    elif status == "cancelled":
        query: dict[str, Any] = {"id": task_id, "status": {"$in": ["open", "accepted"]}}
        if principal.role == "responder":
            query["assignee"] = {"$in": [None, principal.party_key]}
        changes: dict[str, Any] = {"status": "cancelled", "closed_at": now}
        if note:
            changes["note"] = note
        updated = tasks.find_one_and_update(query, {"$set": changes}, return_document=ReturnDocument.AFTER)
        if updated is None:
            return error(409, "conflict", "The task is closed or assigned to someone else.")
    else:
        return error(400, "invalid_request", "`status` must be accepted or cancelled.")
    controller.log_decision(
        task["incident_id"], principal.party_key, f"task_{status}", now, report_ids=task.get("report_ids"), note=note
    )
    return ok({"task": task_json(updated)})


@live_view(["POST"], roles=["controller"])
def impact(request, incident_id: str, principal: Principal):
    return error(501, "not_implemented", "Impact simulation runs are not wired to the live API yet.")


@live_view(["POST"])
def route(request, incident_id: str, principal: Principal):
    return error(501, "not_implemented", "Point-to-point routing is P1 and not implemented yet.")


# ---- v2: situation, check-ins, responder location ----


@live_view(["GET"])
def situation(request, incident_id: str, principal: Principal):
    snapshot = load_snapshot(incident_id, wall_now())
    controller.maybe_auto_replan(snapshot)
    index = snapshot.index
    if principal.role == "responder":
        tasks = responder_tasks(incident_id, principal.party_key)
    elif principal.role == "controller":
        tasks = list(
            col("live_tasks")
            .find({"incident_id": incident_id, "status": {"$in": ["open", "accepted"]}})
            .sort("created_at", -1)
            .limit(COMMAND_TASKS_LIMIT)
        )
    else:
        tasks = []
    checkin = col("live_checkins").find_one({"incident_id": incident_id, "party_key": principal.party_key})
    include_zones = request.query_params.get("zones") != "0"
    return ok(
        {
            "incident_id": incident_id,
            "generated_at": iso(snapshot.now),
            "incident": incident_json(index),
            "drill": drill_short_json(index, snapshot.clock),
            "zones_version": index.drill.zones_version,
            "zones": index.zones_json if include_zones else None,
            "guidance": [guidance_json(g) for g in current_guidance(incident_id, index)],
            "fire": fire_json(snapshot.fire),
            "hazards": [public_item_json(i) for i in snapshot.items],
            "tasks": [task_json(t) for t in tasks],
            "my_checkin": checkin_json(checkin) if checkin else None,
        }
    )


@live_view(["POST"])
def checkins(request, incident_id: str, principal: Principal):
    code = "invalid_checkin"
    body = json_body(request, code)
    status = body.get("status")
    if status not in CHECKIN_STATUSES:
        return error(400, code, "`status` must be out, need_help or staying.")
    zone_id = optional_str(body, "zone_id", code, 200)
    if zone_id is not None and zone_id not in get_index().zones:
        return error(400, code, "Unknown `zone_id`.")
    coord = None
    if body.get("coord") is not None:
        if status != "need_help":
            return error(400, code, "`coord` is allowed only with need_help.")
        coord = parse_coord(body["coord"], "coord", code)
    if rate_limited(f"checkin:{principal.party_key}", CHECKINS_PER_MIN, 60):
        return error(429, "rate_limited", "Too many check-ins. Try again in a minute.")
    now = wall_now()
    doc = col("live_checkins").find_one_and_update(
        {"incident_id": incident_id, "party_key": principal.party_key},
        {
            "$set": {
                "status": status,
                "zone_id": zone_id,
                "coord": [coord[0], coord[1]] if coord else None,
                "role": principal.role,
                "at": now,
                "replay_at": report_replay_at(incident_id, now),
            },
            "$setOnInsert": {"id": new_id("chk_")},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return ok({"checkin": checkin_json(doc)})


@live_view(["POST", "DELETE"], roles=["responder"])
def my_location(request, principal: Principal):
    incident_id = principal.incident_id or controller_incident()
    locations = col("live_responder_locations")
    if request.method == "DELETE":
        locations.delete_one({"incident_id": incident_id, "party_key": principal.party_key})
        return Response(status=204, headers={"Cache-Control": "no-store"})
    code = "invalid_location"
    body = json_body(request, code)
    coord = parse_coord(body.get("coord"), "coord", code)
    accuracy = body.get("accuracy_m")
    if accuracy is not None and (not _bool_number(accuracy) or accuracy < 0):
        return error(400, code, "`accuracy_m` must be a nonnegative number or null.")
    now = wall_now()
    at = parse_iso(body.get("at"), "at", code) if body.get("at") is not None else now
    if at > now + timedelta(seconds=60):
        return error(400, code, "`at` is in the future.")
    if now - at > timedelta(seconds=RESPONDER_LOCATION_TTL_S):
        return error(400, code, "`at` is older than the location expiry.")
    locations.update_one(
        {"incident_id": incident_id, "party_key": principal.party_key},
        {
            "$set": {
                "coord": [coord[0], coord[1]],
                "accuracy_m": float(accuracy) if accuracy is not None else None,
                "at": at,
                "expires_at": at + timedelta(seconds=RESPONDER_LOCATION_TTL_S),
            }
        },
        upsert=True,
    )
    return Response(status=204, headers={"Cache-Control": "no-store"})


# ---- v2: controller ----


def _proposals_for_command(incident_id: str) -> list[dict[str, Any]]:
    proposals = col("live_proposals")
    pending = list(proposals.find({"incident_id": incident_id, "status": "pending"}, {"_id": 0}))
    decided = list(
        proposals.find({"incident_id": incident_id, "status": {"$ne": "pending"}}, {"_id": 0})
        .sort("created_at", -1)
        .limit(controller.DECIDED_PROPOSALS_IN_COMMAND)
    )
    docs = pending + decided
    docs.sort(key=lambda d: d["created_at"], reverse=True)
    return docs


def _checkin_summary(incident_id: str) -> dict[str, Any]:
    rows = col("live_checkins").aggregate(
        [
            {"$match": {"incident_id": incident_id}},
            {
                "$group": {
                    "_id": "$zone_id",
                    "out": {"$sum": {"$cond": [{"$eq": ["$status", "out"]}, 1, 0]}},
                    "need_help": {"$sum": {"$cond": [{"$eq": ["$status", "need_help"]}, 1, 0]}},
                    "staying": {"$sum": {"$cond": [{"$eq": ["$status", "staying"]}, 1, 0]}},
                }
            },
        ]
    )
    by_zone = [
        {"zone_id": r["_id"], "out": r["out"], "need_help": r["need_help"], "staying": r["staying"]}
        for r in rows
        if r["_id"] is not None
    ]
    by_zone.sort(key=lambda r: r["zone_id"])
    need_help = [
        {"id": d["id"], "zone_id": d.get("zone_id"), "coord": d.get("coord"), "at": iso(d["at"])}
        for d in col("live_checkins").find({"incident_id": incident_id, "status": "need_help"}).sort("at", -1)
    ]
    return {"by_zone": by_zone, "need_help": need_help}


@live_view(["GET"], roles=["controller"])
def command(request, incident_id: str, principal: Principal):
    twin_service.warm()
    snapshot = load_snapshot(incident_id, wall_now())
    controller.maybe_auto_replan(snapshot)
    index, now = snapshot.index, snapshot.now
    responders = [
        {"party_key": d["party_key"], "coord": d["coord"], "accuracy_m": d.get("accuracy_m"), "at": iso(d["at"])}
        for d in col("live_responder_locations").find({"incident_id": incident_id, "expires_at": {"$gt": now}})
    ]
    tasks = (
        col("live_tasks")
        .find({"incident_id": incident_id, "status": {"$ne": "cancelled"}})
        .sort("created_at", -1)
        .limit(COMMAND_TASKS_LIMIT)
    )
    return ok(
        {
            "incident_id": incident_id,
            "generated_at": iso(now),
            "incident": incident_json(index),
            "drill": drill_state_json(index, snapshot.clock),
            "fire": fire_json(snapshot.fire),
            "zones_version": index.drill.zones_version,
            "zones": index.command_zones_json,
            "destinations": index.destinations_json,
            "guidance": [guidance_json(g) for g in current_guidance(incident_id, index)],
            "proposals": [proposal_json(p) for p in _proposals_for_command(incident_id)],
            "reports": [report_json(d) for d in snapshot.report_docs[:COMMAND_REPORTS_LIMIT]],
            "road_state": [road_status_json(s) for s in snapshot.road_state],
            "public_items": [public_item_json(i, controller=True) for i in snapshot.items],
            "checkins": _checkin_summary(incident_id),
            "responders": responders,
            "tasks": [task_json(t) for t in tasks],
        }
    )


@live_view(["POST"], roles=["controller"])
def replan(request, incident_id: str, principal: Principal):
    json_body(request)
    snapshot = load_snapshot(incident_id, wall_now())
    pending, auto = controller.replan(snapshot, ["manual"])
    controller.log_decision(
        incident_id, "controller", "replan", snapshot.now, proposal_id=pending["id"] if pending else None
    )
    if pending is None and auto is None:
        return ok({"proposal": None, "auto_approved": None, "detail": "no_changes"})
    return ok(
        {"proposal": proposal_json(pending) if pending else None, "auto_approved": proposal_json(auto) if auto else None},
        status=201,
    )


@live_view(["POST"], roles=["controller"])
def approve_proposal(request, proposal_id: str, principal: Principal):
    body = json_body(request)
    note = optional_str(body, "note", "invalid_request", NOTE_MAX_CHARS)
    zone_ids = body.get("zone_ids")
    if zone_ids is None:
        result = controller.decide(proposal_id, True, note, wall_now())
    else:
        if not isinstance(zone_ids, list) or not zone_ids or not all(isinstance(z, str) for z in zone_ids):
            return error(400, "invalid_request", "`zone_ids` must be a non-empty list of zone ids.")
        result = controller.approve_zones(proposal_id, zone_ids, note, wall_now())
    return ok(
        {
            "proposal": proposal_json(result["proposal"]),
            "guidance": [guidance_json(g) for g in result["guidance"]],
            "tasks": [task_json(t) for t in result["tasks"]],
        }
    )


@live_view(["POST"], roles=["controller"])
def reject_proposal(request, proposal_id: str, principal: Principal):
    note = optional_str(json_body(request), "note", "invalid_request", NOTE_MAX_CHARS)
    result = controller.decide(proposal_id, False, note, wall_now())
    return ok({"proposal": proposal_json(result["proposal"])})


def _parse_speed(value: Any) -> float:
    if not _bool_number(value) or not 0 <= value <= MAX_DRILL_SPEED:
        raise ApiError(400, "invalid_drill", f"`speed` must be a number in 0..{MAX_DRILL_SPEED:g}.")
    return float(value)


def set_drill(incident_id: str, action: str, replay_start_raw: Any = None, speed_raw: Any = None) -> dict[str, Any]:
    """Apply a drill action (also used by the ``live_drill`` command); returns the DrillState JSON."""
    index = get_index()
    drill = index.drill
    now = wall_now()
    drills = col("live_drills")
    doc = drill_doc(incident_id)
    if action == "start":
        replay_start = DEFAULT_REPLAY_START
        if replay_start_raw is not None:
            replay_start = parse_iso(replay_start_raw, "replay_start", "invalid_drill")
            if not drill.clock_start <= replay_start < drill.clock_end:
                raise ApiError(400, "invalid_drill", "`replay_start` must be within the drill clock.")
        speed = _parse_speed(speed_raw) if speed_raw is not None else float((doc or {}).get("speed", 1))
        update = {"replay_start": replay_start, "started_at": now, "speed": speed}
    elif action == "set_speed":
        if speed_raw is None:
            raise ApiError(400, "invalid_drill", "`set_speed` needs `speed`.")
        speed = _parse_speed(speed_raw)
        if doc is None or doc.get("started_at") is None:
            raise ApiError(409, "conflict", "Start the drill before changing its speed.")
        clock = clock_from(doc, index, now)
        update = {"replay_start": clock.replay_now, "started_at": now, "speed": speed}
    elif action == "reset":
        update = {"replay_start": DEFAULT_REPLAY_START, "started_at": None, "speed": 1.0}
        for name in ("live_guidance", "live_proposals", "live_checkins"):
            col(name).delete_many({"incident_id": incident_id})
    else:
        raise ApiError(400, "invalid_drill", "`action` must be start, reset or set_speed.")
    update.update({"updated_at": now, "updated_by": "controller"})
    unset = {"plan_state": "", "last_auto_replan_at": ""} if action == "reset" else {}
    ops: dict[str, Any] = {"$set": update}
    if unset:
        ops["$unset"] = unset
    stored = drills.find_one_and_update(
        {"incident_id": incident_id}, ops, upsert=True, return_document=ReturnDocument.AFTER
    )
    controller.log_decision(incident_id, "controller", f"drill_{action}", now)
    return drill_state_json(index, clock_from(stored, index, now))


@live_view(["POST"], roles=["controller"])
def drill_action(request, incident_id: str, principal: Principal):
    body = json_body(request, "invalid_drill")
    state = set_drill(incident_id, body.get("action"), body.get("replay_start"), body.get("speed"))
    return ok({"drill": state})


# ---- twin (controller): monitoring snapshot and what-if (docs/twin-api.md "HTTP adapter") ----

TWIN_FIRE_AHEAD = frozenset({"replay", "frozen"})
TWIN_RETRY_AFTER_S = "5"


def _twin_unavailable(exc: twin_service.TwinUnavailable) -> Response:
    status = 503 if exc.code in ("warming", "failed") else 409 if exc.code == "finished" else 429
    response = error(status, f"twin_{exc.code}", exc.detail)
    if exc.code in ("warming", "busy"):
        response["Retry-After"] = TWIN_RETRY_AFTER_S
    return response


@live_view(["GET"], roles=["controller"])
def twin(request, incident_id: str, principal: Principal):
    try:
        return ok(twin_service.monitor(load_snapshot(incident_id, wall_now())))
    except twin_service.TwinUnavailable as exc:
        return _twin_unavailable(exc)


@live_view(["POST"], roles=["controller"])
def twin_whatif(request, incident_id: str, principal: Principal):
    body = json_body(request, "invalid_whatif")
    action_sets = body.get("action_sets")
    horizon = body.get("horizon_min", 60)
    fire_ahead = body.get("fire_ahead", "frozen")
    labels = body.get("labels")
    if not isinstance(action_sets, list) or not action_sets or not all(isinstance(a, list) for a in action_sets):
        return error(400, "invalid_whatif", "`action_sets` must be a non-empty list of action lists.")
    if not _bool_number(horizon) or not 0 < horizon <= twin_service.API_MAX_HORIZON_MIN:
        return error(400, "invalid_whatif", f"`horizon_min` must be in (0, {twin_service.API_MAX_HORIZON_MIN}].")
    if fire_ahead not in TWIN_FIRE_AHEAD:
        return error(400, "invalid_whatif", "`fire_ahead` must be frozen or replay.")
    if labels is not None and (not isinstance(labels, list) or not all(isinstance(x, str) for x in labels)):
        return error(400, "invalid_whatif", "`labels` must be a list of strings.")
    try:
        report = twin_service.whatif(load_snapshot(incident_id, wall_now()), action_sets, horizon, fire_ahead, labels)
    except twin_service.TwinUnavailable as exc:
        return _twin_unavailable(exc)
    except Exception as exc:
        if twin_service.is_twin_error(exc):
            return Response(exc.to_dict(), status=400, headers={"Cache-Control": "no-store"})
        raise
    return ok(report)
