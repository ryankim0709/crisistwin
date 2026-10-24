"""Triage quality against the hidden truth log (docs/adr/0042-adversarial-ground-data.md).

Pure and standard library only: the backend AAR (``app/backend/api/live/aar.py``, section
``triage_quality``) and a headless runner gather the drill's outcomes and call ``score_triage``
after the run; ``manifest_metrics`` flattens the result into the secondary metrics of
``sim/evaluation.py`` (docs/strategy-evaluation.md §3). No LLM is involved.

All times are **drill time** (aware UTC): report ``received_at`` is the drill time at receipt
(``replay_at``), decision times are drill times. Minutes are drill minutes.

Definitions (docs/strategy-evaluation.md §3, secondary metrics):

- A report is **true at t** when its truth entry is ``true`` and t is before ``true_until`` (the
  claim stopped holding), or its entry is false but t is at or after ``true_from`` (the claim
  came true later). Reports without a truth entry (real participants, the 2018 record) are not scored.
- **Confirm precision**: of the reports confirmed by the controller (or merged into a confirmed
  one), the share true at decision time. **Confirm recall**: of the true reports received at least
  ``TRIAGE_GRACE_MIN`` before the horizon (help requests excepted, they are answered by dispatch),
  the share confirmed.
- **Dismiss precision / recall**: the same for dismissals (a merge is not a dismissal) of false reports.
- **Minutes to detect a truth change**: from the change to the first controller decision that
  reflects it: confirming a report of the new state, or dismissing or resolving a report of the
  old state, within ``CHANGE_MATCH_RADIUS_M`` of the place. Undetected changes are censored at the
  horizon (counted in ``undetected``); changes after the horizon are not scored.
- **Decisions on false information**: guidance changes and assist dispatches whose cited reports
  all have truth entries and were all false at decision time. Verify tasks on false reports are
  counted separately and not penalised: checking an unverified report is the right response.
- **Rumour containment**: from a rumour's onset to the earlier of (a) the time every member report
  received was dismissed, resolved or merged, and (b) a controller confirmation of the
  contradicting kind at the rumour's place (a public correction). Censored at the horizon.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Any, Literal

TRIAGE_GRACE_MIN = 10.0
"""ASSUMPTION: a report received within this many drill minutes of the horizon is not counted against
recall (nobody could have triaged it yet)."""
CONFIRM_RECALL_EXCLUDED_KINDS = frozenset({"help_needed"})
"""Help requests are answered by dispatch, not by confirmation; they stay in the dismiss metrics."""
CHANGE_MATCH_RADIUS_M = 200.0
"""Same as sim/gen_noise.CHANGE_MATCH_RADIUS_M (livecore/public.py CLUSTER_RADIUS_M)."""
CONTRADICTS = {"road_blocked": "road_passable", "road_passable": "road_blocked"}
EARTH_RADIUS_M = 6_371_008.8

DecisionKind = Literal["guidance_change", "dispatch_assist", "dispatch_verify"]


@dataclass(frozen=True)
class ReportOutcome:
    """One stored report and what the controller did with it (drill times)."""

    event_id: str
    """The generator's id (``client_id``): the truth-log key."""
    report_id: str
    """The server's id (``rpt_...``), as cited by decisions and merges."""
    kind: str
    coord: tuple[float, float] | None
    received_at: datetime
    status: str
    confirmed_at: datetime | None = None
    dismissed_at: datetime | None = None
    resolved_at: datetime | None = None
    merged_at: datetime | None = None
    merged_into: str | None = None


@dataclass(frozen=True)
class Decision:
    """A consequential decision citing reports (server ids)."""

    kind: DecisionKind
    at: datetime
    report_ids: tuple[str, ...]
    ref: str = ""


def parse_utc(value: str | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _dist_m(a: Sequence[float], b: Sequence[float]) -> float:
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(a[0] - b[0]) * math.cos(lat) * EARTH_RADIUS_M
    dy = math.radians(a[1] - b[1]) * EARTH_RADIUS_M
    return math.hypot(dx, dy)


def true_at(entry: Mapping[str, Any], at: datetime) -> bool:
    if entry.get("true"):
        until = parse_utc(entry.get("true_until"))
        return until is None or at < until
    since = parse_utc(entry.get("true_from"))
    return since is not None and at >= since


def _share(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def _minutes(a: datetime, b: datetime) -> float:
    return round((b - a).total_seconds() / 60.0, 1)


def _median(xs: Sequence[float]) -> float | None:
    return round(float(median(xs)), 1) if xs else None


def score_triage(truth: Mapping[str, Mapping[str, Any]], reports: Sequence[ReportOutcome],
                 decisions: Sequence[Decision], horizon: datetime) -> dict[str, Any]:
    """Triage quality of one drill against its truth log. See the module docstring."""
    scored = [r for r in reports if r.event_id in truth and r.received_at <= horizon]
    by_server = {r.report_id: r for r in reports}
    entry = {r.report_id: truth[r.event_id] for r in scored}

    # -- confirmations (a merge into a confirmed report counts as a confirmation at that time)
    confirms: list[tuple[ReportOutcome, datetime]] = []
    for r in scored:
        at = r.confirmed_at
        if at is None and r.merged_into and by_server.get(r.merged_into) and by_server[r.merged_into].confirmed_at:
            at = max(r.merged_at or by_server[r.merged_into].confirmed_at, by_server[r.merged_into].confirmed_at)
        if at is not None and at <= horizon:
            confirms.append((r, at))
    confirm_true = sum(1 for r, at in confirms if true_at(entry[r.report_id], at))
    grace_cut = horizon.timestamp() - TRIAGE_GRACE_MIN * 60
    recall_pool = [r for r in scored if r.received_at.timestamp() <= grace_cut]
    true_pool = [r for r in recall_pool if r.kind not in CONFIRM_RECALL_EXCLUDED_KINDS
                 and true_at(entry[r.report_id], r.received_at)]
    confirmed_ids = {r.report_id for r, _ in confirms}
    false_pool = [r for r in recall_pool if not true_at(entry[r.report_id], r.received_at)]
    dismisses = [(r, r.dismissed_at) for r in scored if r.dismissed_at is not None and r.dismissed_at <= horizon]
    dismiss_false = sum(1 for r, at in dismisses if not true_at(entry[r.report_id], at))
    dismissed_ids = {r.report_id for r, _ in dismisses}

    # -- truth changes
    changes = []
    for key, e in truth.items():
        if e.get("kind_of_noise") != "truth_change":
            continue
        at = parse_utc(e["at"])
        if at is None or at > horizon:
            continue
        detect: datetime | None = None
        for r in reports:
            if r.coord is None or _dist_m(r.coord, e["coord"]) > CHANGE_MATCH_RADIUS_M:
                continue
            cands = []
            if e.get("after") and r.kind == e["after"] and r.confirmed_at:
                cands.append(r.confirmed_at)
            if e.get("before") and r.kind == e["before"]:
                cands += [t for t in (r.dismissed_at, r.resolved_at) if t]
            for t in cands:
                if at <= t <= horizon and (detect is None or t < detect):
                    detect = t
        changes.append({"id": key, "place_id": e.get("place_id"), "at": e["at"], "before": e.get("before"),
                        "after": e.get("after"), "silent": bool(e.get("silent")), "detected": detect is not None,
                        "minutes": _minutes(at, detect if detect is not None else horizon)})

    # -- decisions on false information
    def all_false(d: Decision) -> bool:
        cited = [rid for rid in d.report_ids if rid in by_server]
        if not cited or any(rid not in entry for rid in cited):
            return False  # an unscored (real or record) report, or none: not attributable to noise
        return all(not true_at(entry[rid], d.at) for rid in cited)

    on_false = {"guidance_change": 0, "dispatch_assist": 0, "dispatch_verify": 0}
    totals = {"guidance_change": 0, "dispatch_assist": 0, "dispatch_verify": 0}
    false_refs: list[dict[str, Any]] = []
    for d in decisions:
        if d.at > horizon:
            continue
        totals[d.kind] += 1
        if all_false(d):
            on_false[d.kind] += 1
            false_refs.append({"kind": d.kind, "ref": d.ref, "report_ids": list(d.report_ids)})

    # -- rumours
    rumours: dict[str, dict[str, Any]] = {}
    for r in scored:
        e = entry[r.report_id]
        rid = e.get("rumour_id")
        if not rid:
            continue
        row = rumours.setdefault(rid, {"onset": parse_utc(e.get("rumour_onset_at")) or r.received_at,
                                       "place": e.get("rumour_place") or r.coord, "claim": e.get("claim") or r.kind,
                                       "members": []})
        row["members"].append(r)
    rumour_rows = []
    for rid, row in sorted(rumours.items()):
        onset, members = row["onset"], row["members"]
        closes = []
        for m in members:
            t = min((x for x in (m.dismissed_at, m.resolved_at, m.merged_at) if x is not None), default=None)
            closes.append(t)
        all_closed = max(closes) if closes and all(t is not None and t <= horizon for t in closes) else None
        correction = None
        other = CONTRADICTS.get(row["claim"])
        if other and row["place"] is not None:
            for r in reports:
                if (r.kind == other and r.confirmed_at and onset <= r.confirmed_at <= horizon and r.coord
                        and _dist_m(r.coord, row["place"]) <= CHANGE_MATCH_RADIUS_M):
                    correction = r.confirmed_at if correction is None else min(correction, r.confirmed_at)
        contained = min((t for t in (all_closed, correction) if t is not None), default=None)
        rumour_rows.append({
            "rumour_id": rid, "onset_at": onset.isoformat().replace("+00:00", "Z"), "members_received": len(members),
            "members_dismissed": sum(1 for m in members if m.report_id in dismissed_ids),
            "members_corroborated": sum(1 for m in members if m.status in ("corroborated", "responder_confirmed")),
            "members_confirmed": sum(1 for m in members if m.report_id in confirmed_ids),
            "contained": contained is not None,
            "minutes": _minutes(onset, contained if contained is not None else horizon),
        })

    false_reports = [r for r in scored if not true_at(entry[r.report_id], r.received_at)]
    return {
        "evidence_class": "simulated",
        "basis": "drill minutes; truth from the hidden sim_truth log, read after the drill",
        "horizon": horizon.isoformat().replace("+00:00", "Z"),
        "reports_scored": len(scored),
        "reports_false": len(false_reports),
        "false_auto_corroborated": sum(1 for r in false_reports if r.status in ("corroborated", "responder_confirmed")),
        "confirm": {"n": len(confirms), "true": confirm_true, "precision": _share(confirm_true, len(confirms)),
                    "recall_pool": len(true_pool),
                    "recall": _share(sum(1 for r in true_pool if r.report_id in confirmed_ids), len(true_pool))},
        "dismiss": {"n": len(dismisses), "false": dismiss_false, "precision": _share(dismiss_false, len(dismisses)),
                    "recall_pool": len(false_pool),
                    "recall": _share(sum(1 for r in false_pool if r.report_id in dismissed_ids), len(false_pool))},
        "truth_changes": {"n": len(changes), "undetected": sum(1 for c in changes if not c["detected"]),
                          "median_min": _median([c["minutes"] for c in changes]), "items": changes},
        "decisions_on_false": {
            "guidance_changes": on_false["guidance_change"], "dispatches_assist": on_false["dispatch_assist"],
            "verify_tasks": on_false["dispatch_verify"],
            "total": on_false["guidance_change"] + on_false["dispatch_assist"],
            "of": totals, "items": false_refs[:50],
        },
        "rumours": {"n": len(rumour_rows), "contained": sum(1 for r in rumour_rows if r["contained"]),
                    "median_min": _median([r["minutes"] for r in rumour_rows]), "items": rumour_rows},
        "definitions": "sim/triage_quality.py module docstring; docs/strategy-evaluation.md section 3",
        "constants": {"TRIAGE_GRACE_MIN": TRIAGE_GRACE_MIN, "CHANGE_MATCH_RADIUS_M": CHANGE_MATCH_RADIUS_M,
                      "CONFIRM_RECALL_EXCLUDED_KINDS": sorted(CONFIRM_RECALL_EXCLUDED_KINDS)},
    }


def manifest_metrics(score: Mapping[str, Any]) -> dict[str, float | None]:
    """Flat secondary metrics for ``RunManifest.metrics`` (keys of sim/evaluation.TRIAGE_METRICS)."""
    dof = score["decisions_on_false"]
    return {
        "triage.confirm_precision": score["confirm"]["precision"],
        "triage.confirm_recall": score["confirm"]["recall"],
        "triage.dismiss_precision": score["dismiss"]["precision"],
        "triage.dismiss_recall": score["dismiss"]["recall"],
        "triage.change_detect_min": score["truth_changes"]["median_min"],
        "triage.guidance_changes_on_false": float(dof["guidance_changes"]),
        "triage.dispatches_on_false": float(dof["dispatches_assist"]),
        "decisions_on_false_info": float(dof["total"]),
        "rumour_containment_min": score["rumours"]["median_min"],
    }
