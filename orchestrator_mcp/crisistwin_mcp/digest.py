"""Compact digests of controller API responses for an agent that pays per token.

Pure functions over the backend's JSON. They select and rename fields and drop geometry; every
number is copied verbatim from the backend (planner, twin or bundle). The only things computed
here are counts, groupings and the review-queue flags, which mirror the web console's queue
(``app/src/live/queue.ts``) where that needs no geometry.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

# ---- generic helpers ----


def prune(value: Any) -> Any:
    """Drop ``None`` values and empty lists/dicts, recursively. Absent means null/none/empty."""
    if isinstance(value, dict):
        out = {k: prune(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v is not None and v != [] and v != {}}
    if isinstance(value, list):
        return [prune(v) for v in value]
    return value


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


ZONE_NAME = re.compile(r"^Block Group (\w+), Census Tract ([\w.]+)$")


def short_zone_name(name: str | None) -> str | None:
    """``Block Group 1, Census Tract 9.01`` -> ``Tract 9.01 BG 1`` (same words, shorter)."""
    if not name:
        return name
    m = ZONE_NAME.match(name)
    return f"Tract {m.group(2)} BG {m.group(1)}" if m else name


def destination_ref(dest: dict[str, Any] | None) -> dict[str, Any] | None:
    if not dest:
        return None
    return {"id": dest.get("id"), "name": dest.get("name"), "kind": dest.get("kind")}


def route_summary(route: dict[str, Any] | None, include_line: bool = False) -> dict[str, Any] | None:
    """A guidance or task route without its polyline (``points`` = how many it has)."""
    if not route:
        return None
    out = {k: v for k, v in route.items() if k != "line"}
    line = route.get("line")
    if line is not None:
        out["points"] = len(line)
        if include_line:
            out["line"] = line
    return out


# ---- guidance and proposals ----


def guidance_row(g: dict[str, Any]) -> dict[str, Any]:
    route = g.get("route") or {}
    return {
        "level": g.get("level"),
        "dest": (g.get("destination") or {}).get("id"),
        "dest_name": (g.get("destination") or {}).get("name"),
        "via": route.get("via"),
        "eta_min": route.get("eta_min"),
        "distance_m": route.get("distance_m"),
        "safety": route.get("safety"),
        "no_route": g.get("no_route") or None,
        "caveat": g.get("caveat"),
        "reason_code": g.get("reason_code"),
        "version": g.get("version"),
        "approved_by": g.get("approved_by"),
        "replay_at": g.get("replay_at"),
    }


def change_summary(change: dict[str, Any]) -> dict[str, Any]:
    frm = change.get("from") or {}
    to = change.get("to") or {}
    route = to.get("route") or {}
    return {
        "zone_id": change.get("zone_id"),
        "kind": change.get("kind"),
        "from": {"level": frm.get("level"), "dest": frm.get("destination_id"), "via": frm.get("via")} if frm else None,
        "to": {
            "level": to.get("level"),
            "dest": (to.get("destination") or {}).get("id"),
            "dest_name": (to.get("destination") or {}).get("name"),
            "via": route.get("via"),
            "eta_min": route.get("eta_min"),
            "distance_m": route.get("distance_m"),
            "safety": route.get("safety"),
            "no_route": to.get("no_route") or None,
            "reason_code": to.get("reason_code"),
        },
    }


def twin_evidence_summary(twin: dict[str, Any] | None) -> dict[str, Any] | None:
    """A proposal's TwinEvidence: the chosen set and the baseline, numbers verbatim (simulated)."""
    if not twin:
        return None
    candidates = twin.get("candidates") or []
    chosen = twin.get("chosen")
    return {
        "evidence_class": twin.get("evidence_class"),
        "horizon_min": twin.get("horizon_min"),
        "fire_ahead": twin.get("fire_ahead"),
        "objective": (twin.get("objective") or {}).get("formula"),
        "baseline": {"label": (twin.get("baseline") or {}).get("label"), "cost": (twin.get("baseline") or {}).get("cost")},
        "candidates": [
            {"label": c.get("label"), "valid": c.get("valid"), "cost": c.get("cost"), "chosen": i == chosen or None}
            for i, c in enumerate(candidates)
        ],
        "chosen_metrics": candidates[chosen].get("metrics") if isinstance(chosen, int) and chosen < len(candidates) else None,
    }


def proposal_summary(p: dict[str, Any] | None, with_changes: bool = True) -> dict[str, Any] | None:
    if not p:
        return None
    rationale = p.get("rationale") or {}
    controller = p.get("controller") or {}
    out = {
        "id": p.get("id"),
        "status": p.get("status"),
        "policy": p.get("policy"),
        "created_at": p.get("created_at"),
        "replay_at": p.get("replay_at"),
        "causes": p.get("causes"),
        "cause_segment_ids": p.get("cause_segment_ids"),
        "controller": controller.get("id"),
        "controller_fallback": controller.get("fallback"),
        "n_changes": len(p.get("changes") or []),
        "suggested_tasks": [
            {"target": t.get("target"), "reason": t.get("reason"), "report_ids": t.get("report_ids"),
             "assignee": t.get("assignee")}
            for t in p.get("tasks") or []
        ],
        "rationale": {"text": rationale.get("text"), "by": rationale.get("generated_by"),
                      "evidence_class": rationale.get("evidence_class")} if rationale else None,
        "twin": twin_evidence_summary(p.get("twin")),
        "decided_by": p.get("decided_by"),
        "decided_at": p.get("decided_at"),
        "parent_id": p.get("parent_id"),
        "note": p.get("note"),
    }
    if with_changes:
        out["changes"] = [change_summary(c) for c in p.get("changes") or []]
    return out


def proposal_brief(p: dict[str, Any] | None) -> dict[str, Any] | None:
    """A decided proposal: what happened to it, without its changes or evidence."""
    if not p:
        return None
    return {k: p.get(k) for k in ("id", "status", "policy", "decided_by", "decided_at", "parent_id", "note")} | {
        "n_changes": len(p.get("changes") or [])}


# ---- review queue (mirrors app/src/live/queue.ts, without route geometry) ----

CLOSED = {"dismissed", "resolved"}
UNREVIEWED = {"unverified", "corroborated", "responder_confirmed"}
ROAD_KINDS = {"road_blocked", "road_passable", "heavy_traffic"}
HALF_LIFE_S = {"fire_seen": 900, "heavy_smoke": 900, "heavy_traffic": 900, "road_blocked": 7200,
               "road_passable": 7200, "hazard_down": 14400, "shelter_full": 3600}
DEFAULT_HALF_LIFE_S = 3600
CLUSTER_RADIUS_M = 200.0
FIXTURE_NOTE = re.compile(r"^drill fixture", re.IGNORECASE)
QUEUE_REPORT_IDS = 5


def haversine_m(a: list[float], b: list[float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def _group(reports: Iterable[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    by_segment: dict[str, list[dict[str, Any]]] = {}
    by_destination: dict[str, list[dict[str, Any]]] = {}
    clusters: list[list[dict[str, Any]]] = []
    for r in reports:
        road = r.get("road_ref") or {}
        if r["kind"] in ROAD_KINDS and road.get("segment_id"):
            by_segment.setdefault(road["segment_id"], []).append(r)
        elif r["kind"] == "shelter_full" and r.get("destination_id"):
            by_destination.setdefault(r["destination_id"], []).append(r)
        elif r["kind"] == "help_needed":
            clusters.append([r])
        else:
            coord = r["location"]["coord"]
            near = next((c for c in clusters if c[0]["kind"] == r["kind"] and c[0]["kind"] != "help_needed"
                         and haversine_m(c[0]["location"]["coord"], coord) <= CLUSTER_RADIUS_M), None)
            if near is not None:
                near.append(r)
            else:
                clusters.append([r])
    return [*by_segment.values(), *by_destination.values(), *clusters]


def build_queue(command: dict[str, Any]) -> list[dict[str, Any]]:
    """Open review-queue items, help requests first, then new items, then by parties and recency.

    Flags: ``new`` (unreviewed and not stale), ``stale`` (newest observation older than the kind's
    half-life), ``conflict`` (blocked and passable reports on one road), ``confirmed``, ``record``
    (all 2018 historical-record entries, not drill reports), ``fixture`` (seeded drill fixtures),
    ``tasked`` (an open or accepted task covers it), ``help`` (a need-help check-in). Route impact
    is not computed here: use ``run_impact``.
    """
    now = parse_time(command.get("generated_at")) or datetime.now(UTC)
    open_reports = [r for r in command.get("reports") or [] if r.get("status") not in CLOSED]
    task_by_report: dict[str, dict[str, Any]] = {}
    for t in command.get("tasks") or []:
        if t.get("status") in ("open", "accepted"):
            for rid in t.get("report_ids") or []:
                task_by_report[rid] = t
    items: list[dict[str, Any]] = []
    for rs in _group(open_reports):
        rs.sort(key=lambda r: r.get("observed_at") or "", reverse=True)
        head = rs[0]
        kinds = {r["kind"] for r in rs}
        road = head.get("road_ref") or {}
        segment_id = road.get("segment_id") if head["kind"] in ROAD_KINDS else None
        confirmed = any(r.get("status") == "confirmed" for r in rs)
        observed = parse_time(head.get("observed_at"))
        stale = observed is not None and (now - observed).total_seconds() > HALF_LIFE_S.get(head["kind"], DEFAULT_HALF_LIFE_S)
        record = all(r.get("evidence_class") == "historical_record" for r in rs)
        conflict = None
        if "road_blocked" in kinds and "road_passable" in kinds:
            blocked = sum(r["kind"] == "road_blocked" for r in rs)
            conflict = f"{blocked} blocked, {len(rs) - blocked} passable"
        task = next((task_by_report[r["id"]] for r in rs if r["id"] in task_by_report), None)
        flags = [name for name, on in (
            ("new", not confirmed and not stale and any(r.get("status") in UNREVIEWED for r in rs)),
            ("stale", stale), ("conflict", conflict is not None), ("confirmed", confirmed), ("record", record),
            ("fixture", all(FIXTURE_NOTE.match(r.get("note") or "") for r in rs)), ("tasked", task is not None),
        ) if on]
        item_id = (f"seg:{segment_id}" if segment_id else
                   f"dest:{head['destination_id']}" if head["kind"] == "shelter_full" and head.get("destination_id")
                   else f"rpt:{rs[-1]['id']}")
        items.append({
            "item": item_id,
            "kind": head["kind"],
            "road": road.get("name") if segment_id else None,
            "segment_id": segment_id,
            "destination_id": head.get("destination_id") if head["kind"] == "shelter_full" else None,
            "coord": head["location"]["coord"],
            "flags": flags,
            "conflict": conflict,
            "reports": len(rs),
            # 2018 record entries are not drill parties: no corroboration counts for them.
            "civilian_parties": None if record else len(
                {r["reporter"]["party_key"] for r in rs
                 if r["reporter"]["role"] == "civilian" and r.get("evidence_class") != "historical_record"}),
            "responder_reports": None if record else sum(
                r["reporter"]["role"] == "responder" and r.get("evidence_class") != "historical_record" for r in rs),
            "report_ids": [r["id"] for r in rs[:QUEUE_REPORT_IDS]],
            "newest_replay_at": head.get("replay_at"),
            "note": (head.get("note") or "")[:120] or None,
            "task": task.get("id") if task else None,
        })
    for h in (command.get("checkins") or {}).get("need_help") or []:
        help_ = h.get("help") or {}
        if help_.get("status") == "resolved":
            continue
        items.append({
            "item": f"help:{h['id']}", "kind": "help_needed", "checkin_id": h["id"], "zone_id": h.get("zone_id"),
            "coord": h.get("coord"), "flags": ["help", *(["new"] if help_.get("status", "open") == "open" else [])],
            "help_status": help_.get("status", "open"), "assignee": help_.get("assignee"),
            "task": help_.get("task_id"), "at": h.get("at"),
        })
    items.sort(key=lambda i: i.get("newest_replay_at") or i.get("at") or "", reverse=True)  # newest first, then:
    items.sort(key=lambda i: (
        "help" not in i["flags"], "new" not in i["flags"], "record" in i["flags"],
        -(i.get("civilian_parties") or 0) - (i.get("responder_reports") or 0),
    ))
    return items


# ---- situation ----

TWIN_ZONE_FIELDS = ("not_departed_veh", "en_route_veh", "arrived_veh", "blocked_veh", "exposed_veh")


def situation_digest(command: dict[str, Any], twin: dict[str, Any] | None, twin_error: str | None,
                     max_queue: int, events_cursor: str | None) -> dict[str, Any]:
    drill = command.get("drill") or {}
    fire = command.get("fire") or {}
    guidance = {g["zone_id"]: g for g in command.get("guidance") or []}
    checkins = {c["zone_id"]: c for c in (command.get("checkins") or {}).get("by_zone") or []}
    twin_zones = {z["id"]: z for z in (twin or {}).get("zones") or []}
    ground_zones = {z["zone_id"]: z for z in (command.get("ground_record") or {}).get("zones") or []}
    zones = []
    for z in command.get("zones") or []:
        g = guidance.get(z["id"])
        c = checkins.get(z["id"]) or {}
        tz = twin_zones.get(z["id"]) or {}
        gz = ground_zones.get(z["id"]) or {}
        row = {
            "id": z["id"],
            "name": short_zone_name(z.get("name")),
            "households": z.get("households"),
            "vehicles": z.get("vehicles"),
            **({k: v for k, v in guidance_row(g).items() if k not in ("replay_at", "approved_by")} if g else {"level": None}),
            "checkins": {k: c.get(k) for k in ("out", "need_help", "staying") if c.get(k)} or None,
            "twin": ({k.removesuffix("_veh"): tz.get(k) for k in TWIN_ZONE_FIELDS if tz.get(k)}
                     | ({"ordered": True} if tz.get("ordered_at") else {})) or None,
            "record_30min": {k: gz.get(k) for k in ("items", "help", "fire") if gz.get(k)} or None,
        }
        zones.append(row)
    queue = build_queue(command)
    proposals = command.get("proposals") or []
    pending = [p for p in proposals if p.get("status") == "pending"]
    decided = [p for p in proposals if p.get("status") != "pending"][:5]
    tasks = [t for t in command.get("tasks") or [] if t.get("status") in ("open", "accepted")]
    totals = (twin or {}).get("totals")
    ground = command.get("ground_record") or {}
    return {
        "incident_id": command.get("incident_id"),
        "label": drill.get("label"),
        "generated_at": command.get("generated_at"),
        "clock": {k: drill.get(k) for k in ("replay_now", "speed", "running", "started_at")},
        "fire": {
            "method": fire.get("method"), "as_of": fire.get("as_of"), "label": fire.get("label"),
            "evidence_class": fire.get("evidence_class"), "observations": len(fire.get("observations") or []),
        },
        "zones": zones,
        "queue": {"total": len(queue), "shown": min(len(queue), max_queue), "items": queue[:max_queue]},
        "help_requests": [
            {"checkin_id": h["id"], "zone_id": h.get("zone_id"), "coord": h.get("coord"), "at": h.get("at"),
             **{k: v for k, v in (h.get("help") or {}).items() if k != "updated_at"}}
            for h in (command.get("checkins") or {}).get("need_help") or []
        ],
        "responders": [
            {"party_key": r["party_key"], "coord": r.get("coord"), "at": r.get("at")} for r in command.get("responders") or []
        ],
        "tasks": {
            "open_or_accepted": [
                {"id": t["id"], "kind": t.get("kind"), "status": t["status"], "assignee": t.get("assignee"),
                 "segment_id": (t.get("target") or {}).get("segment_id"), "coord": (t.get("target") or {}).get("coord"),
                 "report_ids": t.get("report_ids"), "checkin_id": t.get("checkin_id"), "created_at": t.get("created_at")}
                for t in tasks
            ],
            "done": sum(t.get("status") == "done" for t in command.get("tasks") or []),
        },
        "proposals": {
            "pending": [proposal_summary(p) for p in pending],
            "recent_decided": [{"id": p["id"], "status": p["status"], "decided_by": p.get("decided_by"),
                                "n_changes": len(p.get("changes") or []), "decided_at": p.get("decided_at")} for p in decided],
        },
        "road_state": [
            {"segment_id": s["segment_id"], "name": s.get("name"), "status": s.get("status"),
             "confidence": s.get("confidence"), "public": s.get("public"), "decided_by": s.get("decided_by"),
             "parties": s.get("independent_parties"), "responder_reports": s.get("responder_reports")}
            for s in command.get("road_state") or []
        ],
        "destination_preferences": command.get("destination_preferences"),
        "twin": ({"evidence_class": "simulated", "clock": (twin.get("clock") or {}).get("now"), "totals": totals,
                  "conserved": twin.get("conserved"), "command_errors": len(twin.get("command_errors") or [])}
                 if twin else {"unavailable": twin_error}),
        "record_2018": {"label": ground.get("label"), "window_min": ground.get("window_min"),
                        "window": ground.get("window"), "totals": ground.get("totals")} if ground.get("available") else None,
        "recent_decisions": (command.get("decisions") or [])[:5],
        "events_cursor": events_cursor,
    }


def zone_detail(command: dict[str, Any], twin: dict[str, Any] | None, zone_id: str,
                include_geometry: bool) -> dict[str, Any] | None:
    zone = next((z for z in command.get("zones") or [] if z["id"] == zone_id), None)
    if zone is None:
        return None
    g = next((g for g in command.get("guidance") or [] if g["zone_id"] == zone_id), None)
    pending_changes = [
        {"proposal_id": p["id"], **change_summary(c)}
        for p in command.get("proposals") or [] if p.get("status") == "pending"
        for c in p.get("changes") or [] if c.get("zone_id") == zone_id
    ]
    tz = next((z for z in (twin or {}).get("zones") or [] if z["id"] == zone_id), None)
    guidance = None
    if g:
        guidance = {
            **guidance_row(g),
            "destination": destination_ref(g.get("destination")),
            "route": route_summary(g.get("route"), include_geometry),
            "reason": g.get("reason"),
            "published_at": g.get("published_at"),
            "proposal_id": g.get("proposal_id"),
            "alternatives": [
                {"destination": destination_ref(a.get("destination")), "route": route_summary(a.get("route")),
                 "safety": a.get("safety"), "load": a.get("load"), "recommended": a.get("recommended")}
                for a in g.get("alternatives") or []
            ],
        }
    return {
        "id": zone_id,
        "name": zone.get("name"),
        "households": zone.get("households"),
        "vehicles": zone.get("vehicles"),
        "geometry": zone.get("geometry") if include_geometry else None,
        "guidance": guidance,
        "pending_changes": pending_changes,
        "checkins": next((c for c in (command.get("checkins") or {}).get("by_zone") or [] if c["zone_id"] == zone_id), None),
        "help_requests": [h for h in (command.get("checkins") or {}).get("need_help") or [] if h.get("zone_id") == zone_id],
        "destination_preferences": [p for p in command.get("destination_preferences") or [] if p["zone_id"] == zone_id],
        "twin": {"evidence_class": "simulated", **{k: v for k, v in tz.items() if k != "id"}} if tz else None,
        "record_30min": next((z for z in (command.get("ground_record") or {}).get("zones") or [] if z["zone_id"] == zone_id), None),
    }


def report_detail(command: dict[str, Any], report_id: str) -> dict[str, Any] | None:
    report = next((r for r in command.get("reports") or [] if r["id"] == report_id), None)
    if report is None:
        return None
    segment_id = (report.get("road_ref") or {}).get("segment_id")
    return {
        "report": {k: v for k, v in report.items() if k not in ("incident_id", "client_id")},
        "road_state": next((s for s in command.get("road_state") or [] if s["segment_id"] == segment_id), None)
        if segment_id else None,
        "public": any((i.get("road_ref") or {}).get("segment_id") == segment_id for i in command.get("public_items") or [])
        if segment_id else None,
        "tasks": [{"id": t["id"], "kind": t.get("kind"), "status": t["status"], "assignee": t.get("assignee")}
                  for t in command.get("tasks") or [] if report_id in (t.get("report_ids") or [])],
        "decisions": [d for d in command.get("decisions") or [] if report_id in (d.get("report_ids") or [])],
        "same_segment_reports": [
            {"id": r["id"], "kind": r["kind"], "status": r["status"], "role": r["reporter"]["role"], "replay_at": r.get("replay_at")}
            for r in command.get("reports") or []
            if segment_id and r["id"] != report_id and (r.get("road_ref") or {}).get("segment_id") == segment_id
        ][:10],
    }


# ---- analyses ----

IMPACT_ZONES_SHOWN = 12


def _impact_side(side: dict[str, Any] | None) -> dict[str, Any] | None:
    if not side:
        return None
    route = side.get("route") or {}
    return {"dest": (side.get("destination") or {}).get("id"), "via": route.get("via"),
            "eta_min": route.get("eta_min"), "exposed": side.get("exposed") or None}


def impact_summary(body: dict[str, Any], max_zones: int = IMPACT_ZONES_SHOWN) -> dict[str, Any]:
    target = body.get("target") or {}
    zones = body.get("zones") or []
    twin = body.get("twin")
    return {
        "replay_at": body.get("replay_at"),
        "target": {k: target.get(k) for k in ("segment_id", "name", "state", "report_ids", "coord")},
        "planner_version": body.get("planner_version"),
        "summary": body.get("summary"),
        "zones_total": len(zones),
        "zones": [
            {"zone_id": z["zone_id"], "level": z.get("level"), "change": z.get("change"),
             "eta_delta_min": z.get("eta_delta_min"), "vehicles": z.get("vehicles"),
             "vehicles_remaining": z.get("vehicles_remaining"),
             "unblocked": _impact_side(z.get("unblocked")), "blocked": _impact_side(z.get("blocked"))}
            for z in zones[:max_zones]
        ],
        "twin": {k: twin.get(k) for k in ("evidence_class", "from", "until", "horizon_min", "fire_ahead", "seed",
                                          "blocked", "unblocked", "delta", "limitations")} if twin else None,
        "twin_fallback": body.get("twin_fallback"),
        "evidence": "planner side computed (free-flow); twin side simulated",
    }


def whatif_summary(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "evidence_class": body.get("evidence_class"),
        "from": body.get("from"), "until": body.get("until"), "horizon_min": body.get("horizon_min"),
        "horizon_clamped": body.get("horizon_clamped") or None, "fire_ahead": body.get("fire_ahead"),
        "seed": body.get("seed"),
        "objective": (body.get("objective") or {}).get("formula"),
        "results": [
            {"set_index": r.get("set_index"), "label": r.get("label"), "valid": r.get("valid"),
             "errors": r.get("errors"), "objective": r.get("objective"), "delta_vs_baseline": r.get("delta_vs_baseline"),
             "metrics": r.get("metrics"),
             "actions": [{"id": a.get("id"), "type": a.get("type"), "effective_at": a.get("effective_at"),
                          "label": a.get("label")} for a in r.get("actions") or []]}
            for r in body.get("results") or []
        ],
        "ranking": body.get("ranking"),
        "limitations": body.get("limitations"),
    }


def task_route_summary(body: dict[str, Any], include_line: bool) -> dict[str, Any]:
    return {**{k: v for k, v in body.items() if k != "route"}, "route": route_summary(body.get("route"), include_line)}


def aar_summary(body: dict[str, Any]) -> dict[str, Any]:
    score = body.get("score") or {}
    help_ = body.get("help") or {}
    return {
        "generated_at": body.get("generated_at"),
        "drill": body.get("drill"),
        "score": {
            **{k: score.get(k) for k in ("value", "max", "coverage", "evidence_class", "formula")},
            "components": [{k: c.get(k) for k in ("id", "evidence_class", "raw", "unit", "score", "effective_weight", "points")}
                           for c in score.get("components") or []],
        },
        "twin": body.get("twin"),
        "triage": body.get("triage"),
        "help": {k: v for k, v in help_.items() if k != "items"},
        "zones": [
            {k: z.get(k) for k in ("zone_id", "first_leave_now_at", "historical_order_at", "leave_now_vs_2018_min",
                                   "leave_now_status", "guidance_changes", "reports", "help_requests",
                                   "arrived_veh", "exposed_veh")}
            for z in body.get("zones") or []
            if z.get("first_leave_now_at") or z.get("reports") or z.get("help_requests")
            or z.get("leave_now_status") not in (None, "none")
        ],
        "timeline_entries": len(body.get("timeline") or []),
        "limitations": body.get("limitations"),
    }
