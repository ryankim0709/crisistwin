"""With/without comparison: acting on the 2018 ground record in the live drill (headless).

A simulated planning experiment, not a claim about what happened in 2018 or what would have
happened. ADR 0031-congestion-aware-planner; command ``live_compare_record``; contract
docs/live-reports.md "Proposals" ("Record comparison harness").

Runs the live drill's own pieces without HTTP, MongoDB or wall time, on one simulation clock:
the traffic twin (``sim.twin.Twin`` built from ``twin_service.build_camp_inputs``, the inputs
the live twin uses), the rule planner (``livecore.planner.plan``), the proposal diff and the
auto-approval policy (``livecore.policy``). Variants, each a fresh twin from ``start``:

- ``A``: baseline. Only the bundle's historical actions (orders, closures and fire in the
  replay history); no drill guidance.
- ``B``: a controller who confirms each 2018 record entry that enters the review queue as
  ``road_blocked`` or ``fire_seen`` (``groundrecord.REPORT_KIND``, entries with a point) at its
  time + ``confirm_delay_min``, and approves every resulting change. Between confirms, the lazy
  replan on a new fire estimate auto-publishes pure unexposed reroutes only (the live policy).
  Planner: congestion-aware with hysteresis (planner-v4), congestion read from this twin.
- ``B_free``: as B with the previous planner (free-flow costs, no hysteresis), to isolate the
  congestion change.

Guidance enters the twin exactly as ``twin_service`` syncs it: a confirmed block ->
``close_road`` (hard) on its segment's edges; a published ``evacuate_now`` -> ``order_zone``;
a published destination -> ``reroute_zone``. Commands apply at the twin's next step.

Times are UTC (``Z``); 2018-11-08 Pacific time is UTC-8 (PST). Vehicle counts are simulated
vehicles; exposure integrals are vehicle-minutes sampled every ``sample_s`` seconds.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from livecore.fire import estimate_fire
from livecore.inbound import congestion_factors
from livecore.planner import PLANNER_VERSION, ZoneGuidance, plan
from livecore.policy import diff, partition, summarize
from livecore.routing import SWITCH_MIN_DWELL_S, SWITCH_MIN_GAIN_FRACTION, SWITCH_MIN_GAIN_S, Incumbent

from . import twin_service
from .common import iso
from .drillcache import DrillIndex, snap_to_segment
from .groundrecord import REPORT_KIND, get_record

log = logging.getLogger(__name__)

EXPERIMENT_KIND = "crisistwin_record_comparison"
LABEL = ("Simulated planning experiment on the live drill's traffic twin and planner. Not a claim "
         "about 2018 events, outcomes or decisions.")
CONFIRMED_KINDS = ("road_blocked", "fire_seen")
"""Queue report kinds the experiment's controller confirms (``groundrecord.REPORT_KIND`` values)."""
DEFAULT_START = "2018-11-08T14:30:00Z"
DEFAULT_END = "2018-11-08T18:00:00Z"
DEFAULT_CONFIRM_DELAY_MIN = 5.0
DEFAULT_CHECKPOINTS = ("2018-11-08T15:30:00Z", "2018-11-08T16:30:00Z", "2018-11-08T17:30:00Z",
                       "2018-11-08T18:00:00Z")
DEFAULT_SAMPLE_S = 60
"""Drill seconds between metric samples and between checks for a new fire estimate."""
TWIN_ACTOR = {"kind": "controller", "id": "record-compare"}
BLOCK_ACTOR = {"kind": "field_report", "id": "record-compare-confirmed"}
PST_OFFSET = timedelta(hours=-8)


@dataclass(frozen=True)
class Confirm:
    """One record entry the experiment's controller confirms."""

    item_id: str
    kind: str
    at: datetime
    """Record time (drill time, UTC)."""
    confirm_at: datetime
    """``max(at + delay, start)``: an entry already queued at the start is confirmed then."""
    segment_id: str | None
    """Snapped road segment for ``road_blocked`` (None when no segment within the snap distance)."""
    road_name: str | None


@dataclass
class _Run:
    name: str
    twin: Any
    published: dict[str, ZoneGuidance] = field(default_factory=dict)
    published_at: dict[str, datetime] = field(default_factory=dict)
    """Zone id -> drill time of its latest published change (the dwell rule's clock)."""
    zone_dest: dict[str, str | None] = field(default_factory=dict)
    blocked: set[str] = field(default_factory=set)
    first_leave_now: dict[str, str] = field(default_factory=dict)
    destination_changes: dict[str, int] = field(default_factory=dict)
    route_changes: dict[str, int] = field(default_factory=dict)
    exposed_veh_min: dict[str, float] = field(default_factory=dict)
    max_exposed_veh: dict[str, int] = field(default_factory=dict)
    arrived: dict[str, dict[str, int]] = field(default_factory=dict)
    """Checkpoint ISO -> zone id -> arrived vehicles."""
    totals: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Checkpoint ISO -> twin totals."""
    max_trapped_by_fire_veh: int = 0
    replans: int = 0
    approvals: int = 0
    auto_publishes: int = 0
    command_errors: list[dict[str, Any]] = field(default_factory=list)
    congestion_reads: list[dict[str, Any]] = field(default_factory=list)
    seq: int = 0
    history: dict[str, list[list[Any]]] = field(default_factory=dict)
    """Zone id -> [[drill time, level, destination id, via]] for every published change."""


def record_confirms(index: DrillIndex, start: datetime, end: datetime, delay: timedelta) -> list[Confirm]:
    """The 2018 record entries that enter the queue as ``road_blocked`` or ``fire_seen`` (with a
    point, as ``groundrecord.materialize_due`` requires) and whose confirm time falls in the window."""
    record = get_record(index)
    if not record.available:
        raise RuntimeError("The 2018 ground record is not available (tools/camp_ground_record.json).")
    out = []
    for at, item in record.items:
        kind = REPORT_KIND.get(item["category"])
        point = record.points.get(item["id"])
        if kind not in CONFIRMED_KINDS or point is None:
            continue
        confirm_at = max(at + delay, start)
        if confirm_at > end:
            continue
        seg = None
        if kind == "road_blocked":
            snapped = snap_to_segment(index, point)
            seg = snapped[0] if snapped else None
        out.append(Confirm(item["id"], kind, at, confirm_at, seg, item.get("road_name")))
    out.sort(key=lambda c: (c.confirm_at, c.item_id))
    return out


def _apply(run: _Run, action: dict[str, Any], key: str, twinmod) -> bool:
    run.seq += 1
    try:
        run.twin.apply({**action, "id": f"{run.name}-{run.seq}"})
        return True
    except twinmod.ActionError as exc:
        if exc.code not in ("already_ordered", "not_closed"):
            run.command_errors.append({"key": key, "at": run.twin.now, **exc.to_dict()})
        return False


def _publish(run: _Run, index: DrillIndex, changes: Sequence[Any], when_iso: str, twinmod) -> None:
    """Publish ``changes`` (``policy.Change``) and send the twin the commands ``twin_service`` would."""
    for c in changes:
        g: ZoneGuidance = c.after
        zid = c.zone_id
        before = run.published.get(zid)
        run.published[zid] = g
        run.published_at[zid] = datetime.fromisoformat(when_iso.replace("Z", "+00:00"))
        run.history.setdefault(zid, []).append([when_iso, g.level, g.destination_id, list(g.via)])
        if g.level == "evacuate_now":
            run.first_leave_now.setdefault(zid, when_iso)
            _apply(run, {"type": "order_zone", "target": {"zone_id": zid}, "params": {}, "actor": dict(TWIN_ACTOR),
                         "rationale": "record-compare: published evacuate_now"}, f"order:{zid}", twinmod)
        moving = g.level != "none" and not g.no_route and g.destination_id is not None
        dest = g.destination_id if moving else None
        if before is not None and before.route is not None and g.route is not None:
            if before.destination_id != g.destination_id:
                run.destination_changes[zid] = run.destination_changes.get(zid, 0) + 1
            if before.destination_id != g.destination_id or tuple(before.via) != tuple(g.via):
                run.route_changes[zid] = run.route_changes.get(zid, 0) + 1
        if dest != run.zone_dest.get(zid) and (dest is not None or zid in run.zone_dest):
            if _apply(run, {"type": "reroute_zone", "target": {"zone_id": zid}, "params": {"destination_id": dest},
                            "actor": dict(TWIN_ACTOR), "rationale": "record-compare: published destination"},
                      f"route:{zid}", twinmod):
                run.zone_dest[zid] = dest


def _plan(run: _Run, index: DrillIndex, now: datetime, congestion_aware: bool) -> list[ZoneGuidance]:
    drill = index.drill
    fire = estimate_fire(drill, now)
    factors = None
    incumbents: dict[str, Incumbent] | None = None
    if congestion_aware:
        factors = congestion_factors(twin_service.edge_speed_rows(run.twin), drill.roads.edges)
        run.congestion_reads.append({"at": run.twin.now, "congested_edges": len(factors)})
        incumbents = {
            z: Incumbent(g.destination_id, tuple(g.route.edge_ids), (now - run.published_at[z]).total_seconds())
            for z, g in run.published.items()
            if g.level != "none" and not g.no_route and g.destination_id is not None and g.route is not None
        }
    run.replans += 1
    return plan(drill, now, fire, frozenset(run.blocked), (), congestion=factors, incumbents=incumbents)


def _sample(run: _Run, dt_min: float) -> None:
    snap = run.twin.snapshot(detail="summary")
    for z in snap["zones"]:
        exposed = int(z["exposed_veh"]) + int(z["exposed_at_origin_veh"])
        run.exposed_veh_min[z["id"]] = run.exposed_veh_min.get(z["id"], 0.0) + exposed * dt_min
        run.max_exposed_veh[z["id"]] = max(run.max_exposed_veh.get(z["id"], 0), exposed)
    run.max_trapped_by_fire_veh = max(run.max_trapped_by_fire_veh, int(snap["totals"]["trapped_by_fire_veh"]))


def _checkpoint(run: _Run, at_iso: str) -> None:
    snap = run.twin.snapshot(detail="summary")
    run.arrived[at_iso] = {z["id"]: int(z["arrived_veh"]) for z in snap["zones"]}
    run.totals[at_iso] = dict(snap["totals"])


def simulate(index: DrillIndex, inputs: Any, variant: str, start: datetime, end: datetime,
             confirms: Sequence[Confirm], checkpoints: Sequence[datetime], sample_s: int,
             progress: Callable[[str], None] = lambda s: None) -> dict[str, Any]:
    """Run one variant (``A``, ``B`` or ``B_free``) and return its raw results."""
    twinmod = twin_service._import_sim()
    t0 = time.perf_counter()
    twin = twinmod.Twin.from_inputs(inputs, start_at=iso(start), session_id=f"record-compare:{variant}")
    run = _Run(variant, twin)
    acting = variant in ("B", "B_free")
    aware = variant == "B"
    pending_confirms = list(confirms) if acting else []
    last_fire = None
    drill = index.drill
    step = timedelta(seconds=sample_s)
    marks = sorted(set(checkpoints))
    t = start
    while t <= end:
        twin.step_to(iso(t))
        while marks and marks[0] <= t:
            _checkpoint(run, iso(marks.pop(0)))
        if acting:
            due = []
            while pending_confirms and pending_confirms[0].confirm_at <= t:
                due.append(pending_confirms.pop(0))
            for c in due:
                if c.segment_id and c.segment_id not in run.blocked:
                    run.blocked.add(c.segment_id)
                    edge_ids = list(drill.roads.segment_edges.get(c.segment_id, ()))
                    if edge_ids:
                        _apply(run, {"type": "close_road", "target": {"edge_ids": edge_ids}, "params": {"mode": "hard"},
                                     "actor": dict(BLOCK_ACTOR),
                                     "rationale": f"record-compare: confirmed {c.item_id} ({c.road_name or 'road'})"},
                               f"block:{c.segment_id}", twinmod)
            fire = estimate_fire(drill, t)
            fire_key = (fire.as_of, fire.method)
            if due:
                # The controller confirms (one replan for the entries due this sample) and approves every change.
                guidance = _plan(run, index, t, aware)
                changes = diff({z: summarize(g) for z, g in run.published.items()}, guidance)
                if changes:
                    run.approvals += 1
                _publish(run, index, changes, iso(t), twinmod)
                last_fire = fire_key
            elif fire_key != last_fire and fire.method != "none":
                # Lazy replan on a new fire estimate: only pure unexposed reroutes publish (auto policy).
                guidance = _plan(run, index, t, aware)
                changes = diff({z: summarize(g) for z, g in run.published.items()}, guidance)
                auto, _ = partition(changes, ["fire"])
                if auto:
                    run.auto_publishes += 1
                _publish(run, index, auto, iso(t), twinmod)
                last_fire = fire_key
        _sample(run, sample_s / 60.0)
        t += step
    final = twin.snapshot(detail="summary")
    progress(f"{variant}: done in {time.perf_counter() - t0:.1f} s")
    return {
        "run": run,
        "final": final,
        "provenance": twin.provenance(),
        "runtime_s": round(time.perf_counter() - t0, 1),
    }


def _pst(at_iso: str | None) -> str | None:
    if not at_iso:
        return None
    t = datetime.fromisoformat(at_iso.replace("Z", "+00:00")) + PST_OFFSET
    return t.strftime("%H:%M PST")


def summarize_variant(index: DrillIndex, result: dict[str, Any], checkpoints: Sequence[str]) -> dict[str, Any]:
    run: _Run = result["run"]
    final = result["final"]
    zones = []
    for z in final["zones"]:
        zid = z["id"]
        zone = index.zones.get(zid)
        zones.append({
            "zone_id": zid,
            "name": getattr(zone, "name", zid),
            "vehicles": int(z["vehicles"]),
            "twin_ordered_at": z["ordered_at"],
            "drill_first_leave_now_at": run.first_leave_now.get(zid),
            "arrived_veh": {cp: run.arrived.get(cp, {}).get(zid) for cp in checkpoints},
            "exposed_veh_min": round(run.exposed_veh_min.get(zid, 0.0), 1),
            "max_exposed_veh": run.max_exposed_veh.get(zid, 0),
            "blocked_veh_at_end": int(z["blocked_veh"]),
            "not_departed_veh_at_end": int(z["not_departed_veh"]),
            "destination": (z.get("assignment") or {}).get("destination_id"),
            "destination_changes": run.destination_changes.get(zid, 0),
            "route_changes": run.route_changes.get(zid, 0),
            "published": run.history.get(zid, []),
        })
    totals_end = final["totals"]
    return {
        "zones": zones,
        "totals": {
            "zones_ordered_by_end": sum(1 for z in zones if z["twin_ordered_at"]),
            "zones_with_drill_leave_now": sum(1 for z in zones if z["drill_first_leave_now_at"]),
            "arrived_veh": {cp: (run.totals.get(cp) or {}).get("arrived_veh") for cp in checkpoints},
            "exposed_veh_min_sampled": round(sum(run.exposed_veh_min.values()), 1),
            "twin_exposed_veh_min_so_far_at_end": totals_end["exposed_veh_min_so_far"],
            "twin_exposed_at_origin_veh_min_so_far_at_end": totals_end["exposed_at_origin_veh_min_so_far"],
            "trapped_by_fire_veh_at_end": totals_end["trapped_by_fire_veh"],
            "max_trapped_by_fire_veh": run.max_trapped_by_fire_veh,
            "blocked_veh_at_end": totals_end["blocked_veh"],
            "not_departed_veh_at_end": totals_end["not_departed_veh"],
            "en_route_veh_at_end": totals_end["en_route_veh"],
            "total_veh": totals_end["total_veh"],
            "conserved": totals_end["not_departed_veh"] + totals_end["en_route_veh"] + totals_end["arrived_veh"]
            == totals_end["total_veh"],
            "destination_changes": sum(run.destination_changes.values()),
            "route_changes": sum(run.route_changes.values()),
            "replans": run.replans,
            "controller_approvals": run.approvals,
            "auto_publishes": run.auto_publishes,
            "twin_commands": len(run.twin.action_log()),
            "command_errors": len(run.command_errors),
            "max_congested_edges_seen_by_planner": max((r["congested_edges"] for r in run.congestion_reads),
                                                       default=None),
        },
        "command_errors": run.command_errors[:20],
        "runtime_s": result["runtime_s"],
        "provenance": result["provenance"],
    }


def compare(index: DrillIndex, *, start_iso: str = DEFAULT_START, end_iso: str = DEFAULT_END,
            confirm_delay_min: float = DEFAULT_CONFIRM_DELAY_MIN, seed: int = twin_service.TWIN_SEED,
            variants: Sequence[str] = ("A", "B", "B_free"), checkpoints_iso: Sequence[str] = DEFAULT_CHECKPOINTS,
            sample_s: int = DEFAULT_SAMPLE_S, progress: Callable[[str], None] = lambda s: None) -> dict[str, Any]:
    """Run the variants and return the JSON report (``kind: crisistwin_record_comparison``)."""
    start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    if not start < end:
        raise ValueError("start must be before end")
    checkpoints = sorted(c for c in (datetime.fromisoformat(s.replace("Z", "+00:00")) for s in checkpoints_iso)
                         if start <= c <= end)
    cp_iso = [iso(c) for c in checkpoints]
    t0 = time.perf_counter()
    inputs = twin_service.build_camp_inputs(seed)
    progress(f"twin inputs built in {time.perf_counter() - t0:.1f} s (seed {seed})")
    confirms = record_confirms(index, start, end, timedelta(minutes=confirm_delay_min))
    out_variants = {}
    for v in variants:
        if v not in ("A", "B", "B_free"):
            raise ValueError(f"unknown variant {v!r}")
        out_variants[v] = summarize_variant(
            index, simulate(index, inputs, v, start, end, confirms, checkpoints, sample_s, progress), cp_iso)
    return {
        "kind": EXPERIMENT_KIND,
        "evidence_class": "simulated",
        "label": LABEL,
        "window": {"start": iso(start), "end": iso(end), "time_zone": "UTC",
                   "local": f"{_pst(iso(start))} to {_pst(iso(end))} (2018-11-08, UTC-8)"},
        "parameters": {
            "confirm_delay_min": confirm_delay_min,
            "seed": seed,
            "sample_s": sample_s,
            "checkpoints": cp_iso,
            "planner_version": PLANNER_VERSION,
            "hysteresis": {"min_gain_s": SWITCH_MIN_GAIN_S, "min_gain_fraction": SWITCH_MIN_GAIN_FRACTION,
                           "min_dwell_s": SWITCH_MIN_DWELL_S},
            "confirmed_kinds": list(CONFIRMED_KINDS),
        },
        "variants_described": {
            "A": "Baseline: only the bundle's historical actions; no drill guidance.",
            "B": (f"Controller confirms each 2018 record road_blocked / fire_seen entry {confirm_delay_min:g} min after "
                  "its time and approves every resulting change; congestion-aware planner with hysteresis."),
            "B_free": "As B, with the previous planner (free-flow costs, no hysteresis).",
        },
        "confirms": [
            {"item_id": c.item_id, "kind": c.kind, "at": iso(c.at), "confirm_at": iso(c.confirm_at),
             "segment_id": c.segment_id, "road_name": c.road_name}
            for c in confirms
        ],
        "variants": out_variants,
        "limitations": [
            "Single seed of an uncalibrated meso traffic model on the replay's demand; small differences are noise.",
            "The fire estimate is the drill's (perimeters and model fronts as of each drill time); confirmed "
            "fire_seen reports trigger a replan but do not change the fire area, as in the live drill.",
            "The controller is idealized: confirms every queued road_blocked / fire_seen entry and approves all changes.",
            "Record entries are de-identified and located to about 100 m; a road_blocked entry closes the nearest segment.",
            "Exposure per zone is sampled at the sample interval (vehicles on fire-exposed edges or waiting at an "
            "origin inside the fire area); trapped-by-fire is a twin total.",
        ],
    }


def _fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:,.1f}"
    if isinstance(v, int):
        return f"{v:,}"
    return str(v)


def markdown(report: dict[str, Any]) -> str:
    p, w = report["parameters"], report["window"]
    variants = report["variants"]
    names = list(variants)
    lines = [
        "# Record comparison (simulated planning experiment)",
        "",
        f"> {report['label']}",
        "",
        f"Window {w['start']} to {w['end']} ({w['local']}). Confirm delay N = {p['confirm_delay_min']:g} min. "
        f"Twin seed {p['seed']}. Planner {p['planner_version']}; hysteresis min gain "
        f"max({p['hysteresis']['min_gain_s']:g} s, {p['hysteresis']['min_gain_fraction']:g} x incumbent cost), "
        f"min dwell {p['hysteresis']['min_dwell_s']:g} s. "
        f"Record entries confirmed: {len(report['confirms'])}.",
        "",
    ]
    for k in names:
        lines.append(f"- **{k}**: {report['variants_described'][k]}")
    lines += ["", "## Totals (simulated vehicles)", "", "| Metric | " + " | ".join(names) + " |",
              "| --- | " + " | ".join("---:" for _ in names) + " |"]
    rows = [
        ("Zones ordered (twin, incl. historical)", "zones_ordered_by_end"),
        ("Zones given leave-now by the drill", "zones_with_drill_leave_now"),
        *((f"Arrived by {cp[11:16]}Z", ("arrived_veh", cp)) for cp in p["checkpoints"]),
        ("Exposed veh-min (sampled, window)", "exposed_veh_min_sampled"),
        ("Trapped by fire at end", "trapped_by_fire_veh_at_end"),
        ("Max trapped by fire", "max_trapped_by_fire_veh"),
        ("Blocked at end", "blocked_veh_at_end"),
        ("Not departed at end", "not_departed_veh_at_end"),
        ("Destination changes", "destination_changes"),
        ("Route changes (destination or via)", "route_changes"),
        ("Replans / approvals / auto-publishes", None),
        ("Twin commands (errors)", None),
    ]
    for label, key in rows:
        cells = []
        for k in names:
            t = variants[k]["totals"]
            if key is None and label.startswith("Replans"):
                cells.append(f"{t['replans']} / {t['controller_approvals']} / {t['auto_publishes']}")
            elif key is None:
                cells.append(f"{t['twin_commands']} ({t['command_errors']})")
            elif isinstance(key, tuple):
                cells.append(_fmt(t[key[0]].get(key[1])))
            else:
                cells.append(_fmt(t[key]))
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    last_cp = p["checkpoints"][-1] if p["checkpoints"] else None
    lines += ["", "## Per zone", "",
              "Leave-now: earliest twin order (historical or drill) / drill's first `evacuate_now` publish. "
              f"Arrived by {last_cp[11:16] if last_cp else '-'}Z. Exposed: sampled veh-min. Changes: destination / route.",
              "", "| Zone | Veh | " + " | ".join(f"{k} leave-now | {k} arrived | {k} exposed | {k} changes" for k in names) + " |",
              "| --- | ---: | " + " | ".join("--- | ---: | ---: | ---:" for _ in names) + " |"]
    by_zone = {k: {z["zone_id"]: z for z in variants[k]["zones"]} for k in names}
    for z in variants[names[0]]["zones"]:
        zid = z["zone_id"]
        cells = []
        for k in names:
            r = by_zone[k][zid]
            order = r["twin_ordered_at"][11:16] if r["twin_ordered_at"] else "-"
            drill_order = r["drill_first_leave_now_at"][11:16] if r["drill_first_leave_now_at"] else "-"
            cells.append(f"{order} / {drill_order} | {_fmt(r['arrived_veh'].get(last_cp))} | "
                         f"{_fmt(r['exposed_veh_min'])} | {r['destination_changes']} / {r['route_changes']}")
        lines.append(f"| {z['name']} | {z['vehicles']} | " + " | ".join(cells) + " |")
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in report["limitations"]] + [""]
    return "\n".join(lines)
