"""The MCP server: CrisisTwin's live controller API as tools for an orchestrator agent (ADR 0033).

Every tool returns compact JSON text. Numbers come verbatim from the backend's models (planner,
traffic twin, bundle); this server only selects fields, drops geometry and counts. Writes carry
``X-CrisisTwin-Actor: agent:<ORCH_AGENT_NAME>``, so the backend's decision log names the agent.
"""

from __future__ import annotations

import json
import logging
from collections import deque
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from . import digest
from .client import BackendError, CrisisTwinClient
from .config import Config

log = logging.getLogger("crisistwin_mcp")

SEEN_EVENT_KEYS = 5000
"""Event keys remembered for de-duplication (the backend redelivers its last ~10 s)."""

INSTRUCTIONS = """\
You are the controller of a CrisisTwin live drill: a labelled training exercise (a replay of the \
2018 Camp Fire or a simulated Studio fire). It is not a real incident, and nothing you do reaches real residents. Outputs \
are planning experiments.

Evidence labels: guidance levels, routes and ETAs are computed by the deterministic planner; \
twin numbers are simulated by an uncalibrated traffic model; reports are unverified until \
confirmed; `historical_record` reports are 2018 calls and radio entries, not drill reports. \
Never state a number the tools did not return. In tool output an absent field means null, \
none or empty.

Start with get_situation, then poll get_events for changes. Times: `at` is wall clock UTC, \
`replay_at` is drill time UTC. Coordinates are [lon, lat] WGS84. Distances are metres.\
"""

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
CLOCK = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)

IncidentArg = Annotated[
    str | None,
    Field(description="Incident id. Omit for the backend's active incident (or ORCH_INCIDENT_ID when set)."),
]
IdIncidentArg = Annotated[
    str | None,
    Field(description="Incident id; optional and unused here (the id above is unique across incidents)."),
]


class TaskTarget(BaseModel):
    """Where the responder goes: a road segment id, a [lon, lat] point, or both."""

    segment_id: str | None = Field(None, description="Road segment id, e.g. osm-way:10297110:0.")
    coord: list[float] | None = Field(None, description="[lon, lat] in WGS84 degrees.", min_length=2, max_length=2)


def dump(value: Any) -> str:
    return json.dumps(digest.prune(value), separators=(",", ":"), ensure_ascii=False)


def build_server(config: Config, client: CrisisTwinClient | None = None) -> FastMCP:
    client = client or CrisisTwinClient(config)
    server = FastMCP("crisistwin-controller", instructions=INSTRUCTIONS)
    cursors: dict[str, str] = {}
    seen: deque[str] = deque(maxlen=SEEN_EVENT_KEYS)
    seen_set: set[str] = set()

    def incident(incident_id: str | None) -> str:
        return (incident_id or config.incident_id or client.active_incident()).strip()

    def call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except BackendError as exc:
            raise ToolError(dump(exc.as_dict())) from None

    def twin_monitor(inc: str) -> tuple[dict[str, Any] | None, str | None]:
        try:
            return client.get(f"incidents/{inc}/twin"), None
        except BackendError as exc:
            return None, exc.code

    def remember(keys: list[str]) -> None:
        for key in keys:
            if len(seen) == seen.maxlen:
                seen_set.discard(seen[0])
            seen.append(key)
            seen_set.add(key)

    # ---- read tools ----

    @server.tool(annotations=READ)
    def get_situation(
        incident_id: IncidentArg = None,
        max_queue: Annotated[int, Field(ge=0, le=200, description="Review-queue items to include.")] = 20,
    ) -> str:
        """Read-only. One compact digest of the drill: clock, fire estimate (no geometry), every zone \
with its published guidance (level, destination, via, ETA, safety), check-in counts and simulated twin \
counts, the review queue with flags (new, stale, conflict, confirmed, record, fixture, tasked, help), \
open help requests, responders, open tasks, pending proposals with their changes, road state, twin \
totals (simulated) and an `events_cursor` for get_events. Changes nothing."""
        inc = incident(incident_id)
        command = call(client.command, inc)
        twin, twin_error = twin_monitor(inc)
        if inc not in cursors:
            try:
                cursors[inc] = client.get(f"incidents/{inc}/events", since="now")["next_cursor"]
            except BackendError as exc:  # an older backend without the event stream: the digest still works
                log.warning("events cursor unavailable: %s", exc.code)
        return dump(digest.situation_digest(command, twin, twin_error, max_queue, cursors.get(inc)))

    @server.tool(annotations=READ)
    def get_events(
        since: Annotated[str | None, Field(
            description="Cursor from a previous next_cursor or events_cursor; 'now' to start at the server "
                        "clock; 'start' for the whole drill. Omit to continue from the last cursor this "
                        "server returned (or 'now' on the first call).")] = None,
        limit: Annotated[int, Field(ge=1, le=500, description="Most events to return.")] = 50,
        incident_id: IncidentArg = None,
    ) -> str:
        """Read-only. What changed since a cursor, oldest first: report (new or updated, with its \
current status), decision (who did what, with actor), proposal (created or decided), guidance \
(a zone's newly published version), checkin, help (a help request's status) and task (created, \
accepted or closed). Each event has key, at (wall UTC), replay_at (drill UTC), type, id and a few \
summary fields. Events already returned by this server are skipped. Returns next_cursor and \
`more` (true: call again now). Changes nothing."""
        inc = incident(incident_id)
        cursor = since if since not in (None, "") else cursors.get(inc, "now")
        query: dict[str, Any] = {"limit": limit}
        if cursor != "start":
            query["since"] = cursor
        body = call(client.get, f"incidents/{inc}/events", **query)
        fresh = [e for e in body.get("events") or [] if e.get("key") not in seen_set]
        remember([e["key"] for e in fresh])
        cursors[inc] = body["next_cursor"]
        skipped = len(body.get("events") or []) - len(fresh)
        events = [digest.prune({k: v for k, v in e.items() if k != "key"}) for e in fresh]  # key: dedupe only
        return json.dumps({"events": events, "next_cursor": body["next_cursor"],
                           "more": bool(body.get("more")), **({"skipped_already_seen": skipped} if skipped else {})},
                          separators=(",", ":"), ensure_ascii=False)

    @server.tool(annotations=READ)
    def get_zone(
        zone_id: Annotated[str, Field(description="Zone id, e.g. bg:060070018001.")],
        include_geometry: Annotated[bool, Field(description="Include the zone polygon and route polyline (large).")] = False,
        incident_id: IncidentArg = None,
    ) -> str:
        """Read-only. One zone in full: published guidance with reason, route summary and \
alternatives (destinations, ETA, safety, load), pending proposal changes for it, check-ins, help \
requests, civilian destination choices, simulated twin counts and 2018 record activity. Changes nothing."""
        inc = incident(incident_id)
        twin, _ = twin_monitor(inc)
        detail = digest.zone_detail(call(client.command, inc), twin, zone_id, include_geometry)
        if detail is None:
            raise ToolError(dump({"error": "not_found", "detail": f"Unknown zone {zone_id}."}))
        return dump(detail)

    @server.tool(annotations=READ)
    def get_report(
        report_id: Annotated[str, Field(description="Report id (rpt_...).")],
        incident_id: IncidentArg = None,
    ) -> str:
        """Read-only. One field report (or 2018 historical-record entry) with its road's state, \
whether it is public, tasks and decisions that reference it, and other reports on the same road \
segment. Searches the newest 500 reports. Changes nothing."""
        detail = digest.report_detail(call(client.command, incident(incident_id)), report_id)
        if detail is None:
            raise ToolError(dump({"error": "not_found", "detail": f"Report {report_id} is not among the newest 500."}))
        return dump(detail)

    @server.tool(annotations=READ)
    def get_task_route(
        task_id: Annotated[str, Field(description="Task id (tsk_...), open or accepted.")],
        from_coord: Annotated[list[float] | None, Field(
            description="[lon, lat] origin; default the assignee's shared location.", min_length=2, max_length=2)] = None,
        include_line: Annotated[bool, Field(description="Include the route polyline (large).")] = False,
        incident_id: IdIncidentArg = None,
    ) -> str:
        """Read-only. The responder's drive route to a task: via roads, distance_m, eta_min, fire \
exposure and whether simulated twin congestion was applied; or a reason (unreachable, no_origin). \
Computed by the backend router, never over blocked roads or the fire. Changes nothing."""
        query = {"from": f"{from_coord[0]},{from_coord[1]}"} if from_coord else {}
        try:
            body = client.get(f"tasks/{task_id}/route", **query)
        except BackendError as exc:
            if exc.status == 409 and isinstance(exc.body, dict) and "reason" in exc.body:
                body = exc.body  # no_origin keeps the route shape
            else:
                raise ToolError(dump(exc.as_dict())) from None
        return dump(digest.task_route_summary(body, include_line))

    @server.tool(annotations=READ)
    def run_impact(
        segment_id: Annotated[str | None, Field(description="Road segment id to test.")] = None,
        report_id: Annotated[str | None, Field(description="Or a road report id: its segment is tested.")] = None,
        horizon_min: Annotated[float, Field(gt=0, le=120, description="Twin what-if minutes.")] = 60,
        max_zones: Annotated[int, Field(ge=1, le=43, description="Affected zones to list.")] = 12,
        incident_id: IncidentArg = None,
    ) -> str:
        """Read-only analysis (stores and publishes nothing). What one road segment being blocked \
versus open costs now: per affected zone the route change and ETA delta (planner, computed, \
free-flow) and the vehicles at risk plus blocked-minus-open metrics from one twin what-if \
(simulated, single seed). Takes a few seconds."""
        if not segment_id and not report_id:
            raise ToolError(dump({"error": "invalid_request", "detail": "Give segment_id or report_id."}))
        body = {"segment_id": segment_id, "report_id": report_id, "horizon_min": horizon_min}
        result = call(client.post, f"incidents/{incident(incident_id)}/impact",
                      {k: v for k, v in body.items() if v is not None}, write=False)
        return dump(digest.impact_summary(result, max_zones))

    @server.tool(annotations=READ)
    def twin_whatif(
        action_sets: Annotated[list[list[dict[str, Any]]], Field(
            description="Candidate action sets, each a list of twin actions such as "
                        '{"type":"reroute_zone","target":{"zone_id":"bg:..."},"params":{"destination_id":"exit:..."}}, '
                        '{"type":"order_zone","target":{"zone_ids":["bg:..."]}}, '
                        '{"type":"close_road","target":{"road_name":"Pentz Road","near":[lon,lat],"radius_m":300}}, '
                        '{"type":"contraflow","target":{"corridor":"Skyway"}}. Catalog: docs/twin-api.md.',
            min_length=1, max_length=8)],
        horizon_min: Annotated[float, Field(gt=0, le=120, description="Simulated minutes ahead.")] = 60,
        fire_ahead: Annotated[Literal["frozen", "replay"], Field(
            description="frozen: fire held at now (information-feasible); replay: the 2018 future fire (hindsight).")] = "frozen",
        labels: Annotated[list[str] | None, Field(description="One label per set.")] = None,
        incident_id: IncidentArg = None,
    ) -> str:
        """Read-only experiment (the live twin is not changed). Runs each action set plus a \
no-new-actions baseline on forks of the simulated traffic twin and returns per set the metrics, \
objective and delta vs baseline, and a ranking. All results simulated (single seed, uncalibrated). \
About 1 s per set."""
        body = {"action_sets": action_sets, "horizon_min": horizon_min, "fire_ahead": fire_ahead, "labels": labels}
        result = call(client.post, f"incidents/{incident(incident_id)}/twin/whatif",
                      {k: v for k, v in body.items() if v is not None}, write=False)
        return dump(digest.whatif_summary(result))

    @server.tool(annotations=READ)
    def get_aar(incident_id: IncidentArg = None) -> str:
        """Read-only. The after-action report so far: drill score (planning-experiment number from \
an uncalibrated model) with components and evidence classes, triage and help timings (observed), \
per-zone leave-now timing vs the 2018 orders (historical) and twin outcomes (simulated). \
Unavailable on backends without the AAR endpoint. Changes nothing."""
        try:
            body = client.get(f"incidents/{incident(incident_id)}/aar")
        except BackendError as exc:
            if exc.status == 404:
                raise ToolError(dump({"error": "aar_unavailable",
                                      "detail": "This backend has no after-action report endpoint."})) from None
            raise ToolError(dump(exc.as_dict())) from None
        return dump(digest.aar_summary(body))

    # ---- write tools ----

    @server.tool(annotations=WRITE)
    def triage_report(
        report_id: Annotated[str, Field(description="Report id (rpt_...).")],
        action: Annotated[Literal["confirm", "dismiss", "merge", "resolve"], Field(
            description="confirm: the controller vouches for it (a confirmed road block or fire report "
                        "enters planning and triggers a replan); dismiss: false or irrelevant; merge: "
                        "duplicate of `into`; resolve: no longer true.")],
        note: Annotated[str | None, Field(max_length=500, description="Short reason, kept in the audit log.")] = None,
        into: Annotated[str | None, Field(description="For merge: the report id to merge into.")] = None,
        incident_id: IdIncidentArg = None,
    ) -> str:
        """Changes drill state. Sets a report's status and logs a decision with this agent as actor. \
Confirming a road_blocked or fire_seen report replans at once; the result then includes the new \
pending proposal (needs approve_proposal) and any auto-approved reroute (already published to drill \
phones). Drill only; nothing reaches real residents."""
        body = {"action": action, "note": note, "into": into}
        result = call(client.post, f"reports/{report_id}/triage", {k: v for k, v in body.items() if v is not None})
        report = result.get("report") or {}
        replan = result.get("replan")
        return dump({
            "report": {k: report.get(k) for k in ("id", "kind", "status", "evidence_class")},
            "replan": {"proposal": digest.proposal_summary(replan.get("proposal")),
                       "auto_approved": digest.proposal_summary(replan.get("auto_approved"))} if replan else None,
        })

    @server.tool(annotations=WRITE)
    def create_task(
        kind: Annotated[Literal["verify", "assist"], Field(
            description="verify: a responder checks a road or place and answers with a report; "
                        "assist: a responder goes to people who need help.")],
        target: Annotated[TaskTarget, Field(description="segment_id and/or coord.")],
        report_ids: Annotated[list[str] | None, Field(max_length=50, description="Reports the task is about.")] = None,
        assignee: Annotated[str | None, Field(
            description="Responder party_key (rsp_...); omit for any responder (first to accept).")] = None,
        note: Annotated[str | None, Field(max_length=500, description="Instruction text for the responder.")] = None,
        incident_id: IncidentArg = None,
    ) -> str:
        """Changes drill state. Creates a task on drill responder phones and logs a decision with this \
agent as actor. Responders in the drill may be real people or simulated; their answers come back \
as reports (see get_events)."""
        tgt = target.model_dump(exclude_none=True)
        if not tgt:
            raise ToolError(dump({"error": "invalid_request", "detail": "target needs segment_id or coord."}))
        body = {"kind": kind, "target": tgt, "report_ids": report_ids or [], "assignee": assignee, "note": note}
        result = call(client.post, f"incidents/{incident(incident_id)}/tasks", {k: v for k, v in body.items() if v is not None})
        return dump({"task": result.get("task")})

    @server.tool(annotations=WRITE)
    def handle_help(
        checkin_id: Annotated[str, Field(description="Check-in id (chk_...) of a need_help request.")],
        action: Annotated[Literal["acknowledge", "assign", "resolve"], Field(
            description="acknowledge: the resident sees 'Request seen'; assign: create an assist task "
                        "(needs a shared location); resolve: close the request and its task.")],
        assignee: Annotated[str | None, Field(description="For assign: responder party_key; omit for any responder.")] = None,
        note: Annotated[str | None, Field(max_length=500)] = None,
        incident_id: IdIncidentArg = None,
    ) -> str:
        """Changes drill state. Updates a resident's help request (shown on their drill phone) and \
logs a decision with this agent as actor."""
        body = {"action": action, "assignee": assignee, "note": note}
        result = call(client.post, f"checkins/{checkin_id}/help", {k: v for k, v in body.items() if v is not None})
        return dump({"checkin": result.get("checkin")})

    @server.tool(annotations=WRITE)
    def replan(incident_id: IncidentArg = None) -> str:
        """Changes drill state (creates a proposal, publishes nothing). Asks the planner for new \
guidance from the current fire estimate and confirmed blocks. Returns the pending proposal with \
its per-zone changes (computed) and twin evidence (simulated) if any, or detail no_changes. A \
manual replan is never auto-approved. Can take ~5-10 s."""
        result = call(client.post, f"incidents/{incident(incident_id)}/replan", {})
        return dump({"proposal": digest.proposal_summary(result.get("proposal")),
                     "auto_approved": digest.proposal_summary(result.get("auto_approved")),
                     "detail": result.get("detail")})

    @server.tool(annotations=WRITE)
    def approve_proposal(
        proposal_id: Annotated[str, Field(description="Pending proposal id (prp_...).")],
        zone_ids: Annotated[list[str] | None, Field(
            description="Approve only these zones' changes; the rest stays pending. Omit for all.")] = None,
        note: Annotated[str | None, Field(max_length=500)] = None,
        incident_id: IdIncidentArg = None,
    ) -> str:
        """Changes drill state. Publishes the proposal's guidance to drill phones in those zones (new \
guidance versions) and creates its suggested tasks; logs a decision with this agent as actor. \
Drill only: labelled exercise guidance, not real evacuation orders."""
        body = {"zone_ids": zone_ids, "note": note}
        result = call(client.post, f"proposals/{proposal_id}/approve", {k: v for k, v in body.items() if v is not None})
        return dump({
            "proposal": digest.proposal_brief(result.get("proposal")),
            "published": [{"zone_id": g["zone_id"], **digest.guidance_row(g)} for g in result.get("guidance") or []],
            "tasks": [t.get("id") for t in result.get("tasks") or []],
        })

    @server.tool(annotations=WRITE)
    def reject_proposal(
        proposal_id: Annotated[str, Field(description="Pending proposal id (prp_...).")],
        note: Annotated[str | None, Field(max_length=500, description="Why, kept in the audit log.")] = None,
        incident_id: IdIncidentArg = None,
    ) -> str:
        """Changes drill state. Rejects the whole pending proposal (nothing is published) and logs a \
decision with this agent as actor."""
        result = call(client.post, f"proposals/{proposal_id}/reject", {"note": note} if note else {})
        return dump({"proposal": digest.proposal_brief(result.get("proposal"))})

    if config.allow_clock:

        @server.tool(annotations=CLOCK)
        def set_drill(
            action: Annotated[Literal["start", "set_speed", "reset"], Field(
                description="start: (re)start the clock; set_speed: change speed without a jump; reset: stop "
                            "and delete guidance, proposals and check-ins (destructive).")],
            speed: Annotated[float | None, Field(ge=0, le=60, description="Drill seconds per wall second; 0 pauses.")] = None,
            replay_start: Annotated[str | None, Field(description="For start: drill time ISO 8601 Z.")] = None,
            incident_id: IncidentArg = None,
        ) -> str:
            """Changes the shared drill clock for everyone in the drill (console and every phone). \
Enabled only because ORCH_ALLOW_CLOCK=1. Logs a decision with this agent as actor."""
            body = {"action": action, "speed": speed, "replay_start": replay_start}
            result = call(client.post, f"incidents/{incident(incident_id)}/drill",
                          {k: v for k, v in body.items() if v is not None})
            return dump({"drill": result.get("drill")})

    return server


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    config = Config.from_env()
    log.info("CrisisTwin controller MCP: %s as %s (clock tools %s)", config.api_base, config.actor,
             "on" if config.allow_clock else "off")
    build_server(config).run("stdio")
