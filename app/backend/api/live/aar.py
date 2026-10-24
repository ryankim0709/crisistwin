"""After-action report and drill score (docs/live-reports.md "After-action report").

Everything is computed from the audit data the drill already stores (``live_decisions``,
``live_guidance``, ``live_reports``, ``live_checkins``, ``live_tasks``), the twin's monitor
totals, and the bundle's historical evacuation orders. No LLM is involved and nothing here
writes. Evidence classes: ``observed`` = what drill participants did (audit data),
``simulated`` = twin-derived, ``historical`` = 2018 record from the bundle.

The score is a transparent weighted mean of four components in [0, 1], scaled to 0-100.
Every constant is in this module's top block. A component without data (e.g. no help
requests, twin still warming) is shown with ``score: null`` and dropped from the mean; the
remaining weights are renormalised, and ``coverage`` reports the weight share that counted.

Layers: ``gather(snapshot)`` reads MongoDB and the twin into an ``AarData``;
``compute_aar(context, data, time_basis=...)`` is pure (no database, no twin) and is what the
headless batch runner (``api.live.batch``) calls with its in-memory documents. ``build_aar`` (the
endpoint) is ``compute_aar(context_from(snapshot), gather(snapshot))`` with ``time_basis="wall"``.
``time_basis="drill"`` measures help, triage and task minutes on the drill clock (the documents'
``replay_at`` where stored, else the drill time estimated from the clock), which is what a batch
run at full speed needs (docs/strategy-evaluation.md section 3).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from statistics import median
from typing import Any

from livecore import drill as drillmod
from livecore.geo import point_in_multipolygon

from . import twin_service
from .common import col, iso
from .state import Snapshot, _aware

# ---- score constants (the only place they live) ----

WEIGHTS = {
    "arrived_share": 0.35,
    "exposed_trapped": 0.30,
    "help_to_assign": 0.15,
    "leave_now_vs_2018": 0.20,
}
"""Component weights; they sum to 1."""
TRAPPED_VEH_MIN_EQUIV = 60.0
"""Each vehicle trapped by fire counts as this many exposed vehicle-minutes (an hour of exposure)."""
EXPOSED_VEH_MIN_PER_VEH_ZERO = 5.0
"""Exposed-or-trapped vehicle-minutes per vehicle at which the component reaches 0."""
HELP_ASSIGN_ZERO_MIN = 30.0
"""Median minutes (wall in a watched drill, drill minutes in a batch run) from a help request to an
assigned responder at which the component reaches 0."""
LEAVE_NOW_SPAN_MIN = 30.0
"""A zone ordered this many minutes before 2018 scores 1, on time 0.5, this many after 0. Clamped."""
HELP_UNASSIGNED_SCORE = 0.0
"""Component score when help was requested but no request was assigned."""
LEAVE_NOW_MISSED_SCORE = 0.0
"""Zone score when the 2018 order time has passed on the drill clock and no leave-now was issued."""

TRIAGE_ACTIONS = ("confirm", "dismiss", "merge", "resolve")
HISTORICAL_ORDER_TYPE = "evacuation_order"
TIME_BASES = ("wall", "drill")
BASIS_UNIT = {"wall": "wall minutes", "drill": "drill minutes"}


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _minutes(a: datetime | None, b: datetime | None) -> float | None:
    """Minutes from ``a`` to ``b`` (rounded to 0.1), None when either is missing or ``b`` is earlier."""
    if a is None or b is None:
        return None
    delta = (b - a).total_seconds() / 60.0
    return round(delta, 1) if delta >= 0 else None


def _median(values: list[float]) -> float | None:
    return round(float(median(values)), 1) if values else None


def _drill_at(snapshot: Snapshot, wall: datetime | None) -> datetime | None:
    """Drill time at wall time ``wall`` under the current clock; an estimate when the speed changed."""
    clock = snapshot.clock
    if wall is None or clock.started_at is None:
        return None
    started = _aware(clock.started_at)
    if wall < started:
        return clock.replay_start
    return drillmod.replay_now(clock.replay_start, clock.started_at, wall, clock.speed,
                               snapshot.index.drill.clock_end)


# ---- pure scoring ----


def score_components(
    twin: dict[str, Any] | None,
    help_assign_median_min: float | None,
    help_requests: int,
    help_assigned: int,
    leave_now_deltas: list[float],
    leave_now_missed: int,
    help_unit: str = BASIS_UNIT["wall"],
) -> dict[str, Any]:
    """The drill score from raw values. ``twin`` is ``{total_veh, arrived_veh, exposed_veh_min,
    trapped_by_fire_veh}`` or None when the twin is unavailable. ``leave_now_deltas`` are minutes
    (drill minus 2018; negative = earlier); ``leave_now_missed`` counts zones whose 2018 order time
    passed with no leave-now. ``help_unit`` labels the help minutes (wall or drill)."""
    comps: list[dict[str, Any]] = []

    arrived = exposed = None
    if twin and twin["total_veh"] > 0:
        arrived = twin["arrived_veh"] / twin["total_veh"]
        exposed = (twin["exposed_veh_min"] + TRAPPED_VEH_MIN_EQUIV * twin["trapped_by_fire_veh"]) / twin["total_veh"]
    comps.append({
        "id": "arrived_share", "label": "Vehicles arrived", "evidence_class": "simulated",
        "raw": None if arrived is None else round(arrived, 4), "unit": "share of vehicles",
        "score": None if arrived is None else round(_clamp01(arrived), 4),
        "rule": "arrived / total vehicles",
    })
    comps.append({
        "id": "exposed_trapped", "label": "Exposed or trapped vehicle-minutes", "evidence_class": "simulated",
        "raw": None if exposed is None else round(exposed, 3), "unit": "veh-min per vehicle",
        "score": None if exposed is None else round(_clamp01(1 - exposed / EXPOSED_VEH_MIN_PER_VEH_ZERO), 4),
        "rule": f"1 - (exposed veh-min + {TRAPPED_VEH_MIN_EQUIV:g} x trapped-by-fire veh) / vehicles / "
                f"{EXPOSED_VEH_MIN_PER_VEH_ZERO:g}",
    })

    if help_assign_median_min is not None:
        help_score: float | None = _clamp01(1 - help_assign_median_min / HELP_ASSIGN_ZERO_MIN)
    elif help_requests > 0 and help_assigned == 0:
        help_score = HELP_UNASSIGNED_SCORE
    else:
        help_score = None
    comps.append({
        "id": "help_to_assign", "label": "Median help to responder assigned", "evidence_class": "observed",
        "raw": help_assign_median_min, "unit": help_unit,
        "score": None if help_score is None else round(help_score, 4),
        "rule": f"1 - median minutes / {HELP_ASSIGN_ZERO_MIN:g}; {HELP_UNASSIGNED_SCORE:g} when requests exist "
                "and none was assigned",
    })

    zone_scores = [_clamp01(0.5 - d / (2 * LEAVE_NOW_SPAN_MIN)) for d in leave_now_deltas]
    zone_scores += [LEAVE_NOW_MISSED_SCORE] * leave_now_missed
    comps.append({
        "id": "leave_now_vs_2018", "label": "Leave-now orders vs 2018", "evidence_class": "historical",
        "raw": _median(leave_now_deltas), "unit": "minutes vs 2018 (negative = earlier), median over zones",
        "score": round(sum(zone_scores) / len(zone_scores), 4) if zone_scores else None,
        "rule": f"mean over zones of clamp(0.5 - minutes / {2 * LEAVE_NOW_SPAN_MIN:g}); "
                f"{LEAVE_NOW_MISSED_SCORE:g} for a zone whose 2018 order time passed with no leave-now",
        "zones_compared": len(leave_now_deltas), "zones_missed": leave_now_missed,
    })

    for c in comps:
        c["weight"] = WEIGHTS[c["id"]]
    counted = [c for c in comps if c["score"] is not None]
    total_w = sum(c["weight"] for c in counted)
    for c in comps:
        c["effective_weight"] = round(c["weight"] / total_w, 4) if c["score"] is not None and total_w else None
        c["points"] = round(100 * c["score"] * c["effective_weight"], 1) if c["effective_weight"] is not None else None
    score = round(sum(c["points"] for c in counted), 1) if counted else None
    return {
        "value": score,
        "max": 100,
        "coverage": round(total_w, 4),
        "components": comps,
        "formula": "100 x sum(effective_weight x component score); components without data are dropped "
                   "and the remaining weights renormalised",
        "evidence_class": "simulated",
        "label": "Planning-experiment score of a drill. Twin parts are simulated; the 2018 comparison is historical.",
    }


# ---- inputs ----


@dataclass(frozen=True)
class AarContext:
    """The drill around the audit data: which incident, the drill index and the drill clock.

    ``drill_at(wall)`` maps a wall time to the drill time the clock showed then (None when no
    drill ran). A batch run has one clock, so its ``drill_at`` is the identity."""

    incident_id: str
    index: Any
    """``drillcache.DrillIndex``: zones and the bundle's historical record."""
    now: datetime
    """``generated_at``: wall time of the read (a batch run passes its drill horizon)."""
    replay_start: datetime | None
    replay_now: datetime | None
    started_at: datetime | None
    speed: float
    running: bool
    drill_at: Callable[[datetime | None], datetime | None]


@dataclass
class AarData:
    """The audit documents the AAR reads, in their stored shapes (``live_*`` collections).

    ``decisions`` sorted by ``at``, ``guidance`` by ``version``. ``reports`` exclude
    ``historical_record`` entries. ``twin`` is the ``twin_outcomes`` shape."""

    decisions: list[dict[str, Any]] = field(default_factory=list)
    proposals: list[dict[str, Any]] = field(default_factory=list)
    checkins: list[dict[str, Any]] = field(default_factory=list)
    guidance: list[dict[str, Any]] = field(default_factory=list)
    reports: list[dict[str, Any]] = field(default_factory=list)
    tasks: list[dict[str, Any]] = field(default_factory=list)
    twin: dict[str, Any] = field(default_factory=lambda: {
        "status": "unavailable", "detail": "no twin", "evidence_class": "simulated", "totals": None, "zones": {}})


def context_from(snapshot: Snapshot) -> AarContext:
    clock = snapshot.clock
    return AarContext(
        incident_id=snapshot.incident_id, index=snapshot.index, now=snapshot.now,
        replay_start=clock.replay_start, replay_now=clock.replay_now, started_at=clock.started_at,
        speed=clock.speed, running=clock.running, drill_at=lambda wall: _drill_at(snapshot, wall),
    )


def twin_outcomes(mon: dict[str, Any]) -> dict[str, Any]:
    """The AAR's twin block from a monitor-shaped dict (``totals``; ``zones`` with id, vehicles,
    arrived_veh, exposed_veh). ``twin_service.monitor`` returns one; so can a headless twin."""
    t = mon["totals"]
    return {
        "status": "ok",
        "evidence_class": "simulated",
        "label": mon.get("label"),
        "clock": (mon.get("clock") or {}).get("now") or mon.get("drill_replay_now"),
        "totals": {k: t.get(k) for k in (
            "total_veh", "not_departed_veh", "en_route_veh", "arrived_veh", "exposed_veh", "trapped_by_fire_veh",
            "trapped_by_closure_veh", "exposed_veh_min_so_far")},
        "zones": {z["id"]: {k: z[k] for k in ("vehicles", "arrived_veh", "exposed_veh")} for z in mon["zones"]},
    }


# ---- triage quality against the hidden truth log (ADR 0042) ----

GUIDANCE_CONFIRM_LINK_S = 5.0
"""A proposal created within this many wall seconds after a controller confirm is the replan that
confirm triggered (views.triage replans in the same request), so it cites the confirmed report."""


def _triage_quality_module():
    from .simtruth import _gen_noise  # puts the repository root on sys.path

    _gen_noise()
    from sim import triage_quality

    return triage_quality


def triage_quality(snapshot: Snapshot, decisions: list[dict[str, Any]]) -> dict[str, Any]:
    """Score triage against ``sim_truth`` (sim/triage_quality.py). Reads the truth log: call only
    after the drill (``build_aar(..., truth_scoring=True)``)."""
    from .simtruth import read_truth

    tq = _triage_quality_module()
    incident_id = snapshot.incident_id
    truth = read_truth(incident_id)
    horizon = snapshot.clock.replay_now
    if not truth or horizon is None:
        return {"status": "no_truth" if not truth else "no_drill", "evidence_class": "simulated"}

    def drill_time(doc: dict[str, Any], wall_key: str) -> datetime | None:
        return _aware(doc.get("replay_at")) or _drill_at(snapshot, _aware(doc.get(wall_key)))

    firsts: dict[tuple[str, str], datetime] = {}
    confirm_walls: list[tuple[datetime, list[str]]] = []
    for d in decisions:
        at = drill_time(d, "at")
        ids = d.get("report_ids") or []
        if d["action"] in TRIAGE_ACTIONS and ids and at is not None:
            firsts.setdefault((ids[0], d["action"]), at)
        if d["action"] == "confirm" and ids:
            confirm_walls.append((_aware(d["at"]), ids[:1]))
    docs = list(col("live_reports").find({"incident_id": incident_id, "evidence_class": {"$ne": "historical_record"}}))
    outcomes = []
    for r in docs:
        received = drill_time(r, "received_at")
        if received is None:
            continue
        coord = (r.get("location") or {}).get("coord")
        outcomes.append(tq.ReportOutcome(
            event_id=r["client_id"], report_id=r["id"], kind=r["kind"],
            coord=(coord[0], coord[1]) if coord else None, received_at=received, status=r["status"],
            confirmed_at=firsts.get((r["id"], "confirm")), dismissed_at=firsts.get((r["id"], "dismiss")),
            resolved_at=firsts.get((r["id"], "resolve")), merged_at=firsts.get((r["id"], "merge")),
            merged_into=r.get("merged_into"),
        ))

    # Guidance changes cite the reports behind their proposal: road_blocked reports on its cause
    # segments received by then, and the report whose confirm triggered it.
    blocked_by_seg: dict[str, list[dict[str, Any]]] = {}
    for r in docs:
        seg = (r.get("road_ref") or {}).get("segment_id")
        if r["kind"] == "road_blocked" and seg:
            blocked_by_seg.setdefault(seg, []).append(r)
    proposals = {p["id"]: p for p in col("live_proposals").find({"incident_id": incident_id})}
    acts = []
    for g in col("live_guidance").find({"incident_id": incident_id}):
        prop = proposals.get(g.get("proposal_id") or "")
        if prop is None:
            continue
        created = _aware(prop["created_at"])
        cited = [r["id"] for seg in prop.get("cause_segment_ids") or [] for r in blocked_by_seg.get(seg, [])
                 if _aware(r["received_at"]) <= created]
        cited += [i for wall, ids in confirm_walls if wall is not None
                  and 0 <= (created - wall).total_seconds() <= GUIDANCE_CONFIRM_LINK_S for i in ids]
        at = _aware(g.get("replay_at")) or _drill_at(snapshot, _aware(g["published_at"]))
        if cited and at is not None:
            acts.append(tq.Decision("guidance_change", at, tuple(dict.fromkeys(cited)), f"{g['zone_id']}@v{g['version']}"))
    for t in col("live_tasks").find({"incident_id": incident_id}):
        at = drill_time(t, "created_at")
        if t.get("report_ids") and at is not None:
            kind = "dispatch_assist" if t.get("kind") == "assist" else "dispatch_verify"
            acts.append(tq.Decision(kind, at, tuple(t["report_ids"]), t["id"]))
    score = tq.score_triage(truth, outcomes, acts, horizon)
    return {"status": "ok", **score, "metrics": tq.manifest_metrics(score)}


def _twin_outcomes(snapshot: Snapshot) -> dict[str, Any]:
    try:
        mon = twin_service.monitor(snapshot)
    except twin_service.TwinUnavailable as exc:
        return {"status": exc.code, "detail": exc.detail, "evidence_class": "simulated", "totals": None, "zones": {}}
    return twin_outcomes(mon)


def gather(snapshot: Snapshot) -> AarData:
    """Read the incident's audit documents from MongoDB and the live twin's outcomes."""
    incident_id = snapshot.incident_id
    return AarData(
        decisions=list(col("live_decisions").find({"incident_id": incident_id}).sort("at", 1)),
        proposals=list(col("live_proposals").find({"incident_id": incident_id})),
        checkins=list(col("live_checkins").find({"incident_id": incident_id})),
        guidance=list(col("live_guidance").find({"incident_id": incident_id}).sort("version", 1)),
        reports=list(col("live_reports").find(
            {"incident_id": incident_id, "evidence_class": {"$ne": "historical_record"}})),
        tasks=list(col("live_tasks").find({"incident_id": incident_id})),
        twin=_twin_outcomes(snapshot),
    )


# ---- computation (pure) ----


def _historical_orders(index: Any) -> dict[str, datetime]:
    """Earliest 2018 evacuation order per zone from the bundle's historical events."""
    out: dict[str, datetime] = {}
    for at, item in index.response_record:
        if item.get("type") != HISTORICAL_ORDER_TYPE:
            continue
        for zone_id in item.get("zone_ids") or []:
            if zone_id not in out or at < out[zone_id]:
                out[zone_id] = at
    return out


def _zone_of(index: Any, coord: Any, cache: dict[tuple[float, float], str | None]) -> str | None:
    if not coord or len(coord) != 2:
        return None
    key = (round(coord[0], 5), round(coord[1], 5))
    if key not in cache:
        cache[key] = next(
            (z.id for z in index.drill.zones if point_in_multipolygon((coord[0], coord[1]), z.geometry)),
            None,
        )
    return cache[key]


def compute_aar(ctx: AarContext, data: AarData, *, time_basis: str = "wall") -> dict[str, Any]:
    """The after-action report from explicit inputs; no database or twin access.

    ``time_basis="wall"`` (the live endpoint) measures triage, help and task minutes between
    the stored wall times. ``"drill"`` measures them between drill times: a document's
    ``replay_at`` (``created_replay_at``/``accepted_replay_at``/``closed_replay_at`` for tasks)
    when stored, else ``ctx.drill_at`` of its wall time."""
    if time_basis not in TIME_BASES:
        raise ValueError(f"time_basis must be one of {TIME_BASES}")
    basis_unit = BASIS_UNIT[time_basis]
    index = ctx.index
    zones = index.drill.zones
    replay_now = ctx.replay_now

    def when(doc: dict[str, Any] | None, wall_key: str, replay_key: str | None = "replay_at") -> datetime | None:
        if not doc:
            return None
        wall = _aware(doc.get(wall_key))
        if time_basis == "wall":
            return wall
        stored = _aware(doc.get(replay_key)) if replay_key else None
        return stored or ctx.drill_at(wall)

    # -- timeline
    decisions = data.decisions
    proposals = {p["id"]: p for p in data.proposals}
    checkins = data.checkins
    checkin_replay = {c["id"]: _aware(c.get("replay_at")) for c in checkins}
    timeline = []
    for d in decisions:
        wall = _aware(d["at"])
        prop = proposals.get(d.get("proposal_id") or "")
        drill_at = (
            _aware(prop.get("decided_replay_at")) if prop and d["action"] in ("approve", "reject") else None
        ) or _aware(d.get("replay_at")) or ctx.drill_at(wall)
        timeline.append({
            "at": iso(wall),
            "drill_at": iso(drill_at),
            "actor": d["actor"],
            "action": d["action"],
            "report_ids": d.get("report_ids") or [],
            "proposal_id": d.get("proposal_id"),
            "checkin_id": d.get("checkin_id"),
            "note": d.get("note"),
            "evidence_class": "observed",
        })

    # -- per-zone: guidance, reports
    by_zone: dict[str, dict[str, Any]] = {
        z.id: {"zone_id": z.id, "name": z.name, "vehicles": z.vehicles, "guidance_changes": 0,
               "first_leave_now_at": None, "first_leave_now_wall": None, "historical_order_at": None,
               "leave_now_vs_2018_min": None, "leave_now_status": "none",
               "reports": 0, "triage_median_min": None}
        for z in zones
    }
    first_leave: dict[str, tuple[datetime, datetime | None]] = {}
    for g in data.guidance:
        row = by_zone.get(g["zone_id"])
        if row is None:
            continue
        row["guidance_changes"] += 1
        if g["level"] == "evacuate_now":
            wall = _aware(g["published_at"])
            drill_at = _aware(g.get("replay_at")) or ctx.drill_at(wall)
            if drill_at is not None and (g["zone_id"] not in first_leave or drill_at < first_leave[g["zone_id"]][0]):
                first_leave[g["zone_id"]] = (drill_at, wall)

    orders = _historical_orders(index)
    deltas: list[float] = []
    missed = 0
    for zone_id, row in by_zone.items():
        hist = orders.get(zone_id)
        row["historical_order_at"] = iso(hist)
        if zone_id in first_leave:
            at, wall = first_leave[zone_id]
            row["first_leave_now_at"], row["first_leave_now_wall"] = iso(at), iso(wall)
            if hist is not None:
                delta = round((at - hist).total_seconds() / 60.0, 1)
                row["leave_now_vs_2018_min"] = delta
                row["leave_now_status"] = "earlier" if delta < 0 else "later" if delta > 0 else "same"
                deltas.append(delta)
        elif hist is not None and replay_now is not None and hist <= replay_now:
            row["leave_now_status"] = "missed"
            missed += 1

    zone_cache: dict[tuple[float, float], str | None] = {}
    triage_at: dict[str, datetime | None] = {}
    for d in decisions:
        if d["action"] in TRIAGE_ACTIONS and d.get("report_ids"):
            triage_at.setdefault(d["report_ids"][0], when(d, "at"))
    triage_all: list[float] = []
    per_zone_triage: dict[str, list[float]] = {}
    reports_total = 0
    for r in data.reports:
        if r.get("evidence_class") == "historical_record":
            continue
        reports_total += 1
        zone_id = _zone_of(index, (r.get("location") or {}).get("coord"), zone_cache)
        if zone_id in by_zone:
            by_zone[zone_id]["reports"] += 1
        mins = _minutes(when(r, "received_at"), triage_at.get(r["id"]))
        if mins is not None:
            triage_all.append(mins)
            if zone_id in by_zone:
                per_zone_triage.setdefault(zone_id, []).append(mins)
    for zone_id, vals in per_zone_triage.items():
        by_zone[zone_id]["triage_median_min"] = _median(vals)

    # -- help requests
    assign_at: dict[str, datetime | None] = {}
    resolve_at: dict[str, datetime | None] = {}
    for d in decisions:
        cid = d.get("checkin_id")
        if cid and d["action"] == "help_assign":
            assign_at.setdefault(cid, when(d, "at"))
        elif cid and d["action"] == "help_resolve":
            resolve_at.setdefault(cid, when(d, "at"))
    help_rows = []
    assign_mins: list[float] = []
    resolve_mins: list[float] = []
    for c in checkins:
        help_ = c.get("help")
        if not help_:
            continue
        # The request time is the check-in time; a resident who later checked in as out or staying
        # overwrote it, so those requests have no known start and are listed without minutes.
        requested = when(c, "at") if c["status"] == "need_help" else None
        assigned = assign_at.get(c["id"])
        resolved = resolve_at.get(c["id"])
        if resolved is None and help_.get("status") == "resolved":
            resolved = when(help_, "updated_at")
        to_assign = _minutes(requested, assigned)
        to_resolve = _minutes(requested, resolved)
        if to_assign is not None:
            assign_mins.append(to_assign)
        if to_resolve is not None:
            resolve_mins.append(to_resolve)
        help_rows.append({
            "checkin_id": c["id"], "zone_id": c.get("zone_id"), "status": help_.get("status", "open"),
            "requested_at": iso(requested), "assigned_at": iso(assigned), "resolved_at": iso(resolved),
            "requested_drill_at": iso(checkin_replay.get(c["id"])),
            "to_assign_min": to_assign, "to_resolve_min": to_resolve,
        })
    for zone_id in by_zone:
        zm = [r["to_assign_min"] for r in help_rows if r["zone_id"] == zone_id and r["to_assign_min"] is not None]
        by_zone[zone_id]["help_requests"] = sum(1 for r in help_rows if r["zone_id"] == zone_id)
        by_zone[zone_id]["help_to_assign_median_min"] = _median(zm)
    tasks = data.tasks
    task_mins = [
        m for t in tasks
        if (m := _minutes(when(t, "created_at", "created_replay_at"), when(t, "accepted_at", "accepted_replay_at")))
        is not None
    ]
    close_mins = [
        m for t in tasks
        if (m := _minutes(when(t, "accepted_at", "accepted_replay_at"), when(t, "closed_at", "closed_replay_at")))
        is not None
    ]

    # -- twin and score
    twin = data.twin
    if twin["status"] == "ok":
        for zone_id, z in twin["zones"].items():
            if zone_id in by_zone:
                by_zone[zone_id].update(arrived_veh=z["arrived_veh"], exposed_veh=z["exposed_veh"])
    score_twin = None
    if twin["totals"]:
        t = twin["totals"]
        score_twin = {
            "total_veh": t["total_veh"], "arrived_veh": t["arrived_veh"],
            "exposed_veh_min": t["exposed_veh_min_so_far"] or 0.0,
            "trapped_by_fire_veh": t["trapped_by_fire_veh"] or 0,
        }
    score = score_components(
        score_twin, _median(assign_mins), len(help_rows), len(assign_mins), deltas, missed, help_unit=basis_unit,
    )

    out = {
        "kind": "crisistwin_live_aar",
        "incident_id": ctx.incident_id,
        "generated_at": iso(ctx.now),
        "time_basis": time_basis,
        "drill": {
            "replay_start": iso(ctx.replay_start), "replay_now": iso(replay_now),
            "started_at": iso(ctx.started_at), "speed": ctx.speed,
            "running": ctx.running,
        },
        "score": score,
        "twin": twin,
        "zones": list(by_zone.values()),
        "triage": {"evidence_class": "observed", "basis": basis_unit, "reports": reports_total,
                   "triaged": len(triage_all), "median_min": _median(triage_all)},
        "help": {
            "evidence_class": "observed", "basis": basis_unit, "requests": len(help_rows),
            "to_assign_median_min": _median(assign_mins), "to_resolve_median_min": _median(resolve_mins),
            "task_to_accept_median_min": _median(task_mins), "task_accept_to_close_median_min": _median(close_mins),
            "items": help_rows,
        },
        "timeline": timeline,
        "evidence": {
            "timeline": "observed: audit log; drill_at is the proposal's decided drill time, else estimated from "
                        "the current drill clock",
            "twin": "simulated: traffic twin at the current twin clock",
            "historical_order_at": "historical: earliest 2018 evacuation order for the zone in the bundle",
        },
        "limitations": [
            "A help request's start is the check-in time; requests a resident later closed have no minutes.",
            "Drill times of decisions without a stored drill time assume the clock speed did not change.",
        ],
    }
    return out


def build_aar(snapshot: Snapshot, truth_scoring: bool = False) -> dict[str, Any]:
    """The endpoint's report: MongoDB audit data and the live twin, minutes on the wall clock.
    ``truth_scoring`` adds ``triage_quality`` from the hidden truth log: the endpoint passes it only
    with ``?truth=1``, ``LIVE_TRUTH_SCORING`` on and the drill stopped."""
    data = gather(snapshot)
    out = compute_aar(context_from(snapshot), data, time_basis="wall")
    if truth_scoring:
        out["triage_quality"] = triage_quality(snapshot, data.decisions)
    return out
