"""Hidden ground-truth log of generated drill data, and in-process injection (docs/adr/0042-adversarial-ground-data.md).

``sim_truth`` holds, per ``(incident_id, event_id)``, whether a generated report was true and which
noise produced it (``sim/gen_noise.py``). Isolation rules:

- No endpoint, console view, phone view or MCP tool reads it. This module is the only reader, and its
  one read, ``read_truth``, is called only by ``aar.build_aar(..., truth_scoring=True)``: from the
  AAR endpoint with ``?truth=1`` when ``settings.LIVE_TRUTH_SCORING`` is true and the drill is
  stopped, or from a headless run in Python. ``tests/test_sim_truth.py`` checks both by scanning the
  code and by calling every GET endpoint with a seeded truth log.
- Truth never goes onto a ``live_reports`` document (``report_json`` renders every stored field):
  injected reports carry only the fields a phone would POST, plus ``evidence_class: "simulated"``.

Injection writes generated phone and responder reports straight into ``live_reports`` with the same
fields ``views._submit_report`` stores, the same input validation, road snapping, idempotency on
``client_id`` and the civilian rate limits (counted on the events' upload drill times), then
refreshes corroboration once. Times: ``replay_at`` is the event's upload drill time; ``received_at``
and ``observed_at`` are wall times (as a phone's), ``observed_at`` keeping the event's lag before
upload, because the public rules fade on wall time. Comms items (911, radio) are not phone reports and are not injected.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from pymongo import UpdateOne

from .common import ApiError, col, new_id
from .drillcache import get_index, snap_to_segment

COLLECTION = "sim_truth"
EVIDENCE_CLASS = "simulated"


def _gen_noise():
    """``sim.gen_noise`` from the repository root (as twin_service imports ``sim.twin``)."""
    from .twin_service import REPO_ROOT

    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.append(root)
    from sim import gen_noise

    return gen_noise


def write_truth(incident_id: str, truth: Mapping[str, Mapping[str, Any]], now: datetime, *,
                profile: str | None = None, seed: int | None = None) -> int:
    """Upsert one ``sim_truth`` document per entry. Returns the number written."""
    ops = []
    for event_id, entry in truth.items():
        doc = {
            "incident_id": incident_id,
            "event_id": str(event_id),
            "true": bool(entry["true"]),
            "kind_of_noise": entry.get("kind_of_noise"),
            "source_event_id": entry.get("source_event_id"),
            "notes": entry.get("notes"),
            "entry": dict(entry),
            "profile": profile,
            "seed": seed,
            "written_at": now,
        }
        ops.append(UpdateOne({"incident_id": incident_id, "event_id": doc["event_id"]}, {"$set": doc}, upsert=True))
    if ops:
        col(COLLECTION).bulk_write(ops, ordered=False)
    return len(ops)


def read_truth(incident_id: str) -> dict[str, dict[str, Any]]:
    """The truth log of an incident, ``event_id -> entry``. Only ``aar`` may call this, after the drill."""
    return {d["event_id"]: d["entry"] for d in col(COLLECTION).find({"incident_id": incident_id}, {"_id": 0})}


def clear_truth(incident_id: str) -> int:
    return col(COLLECTION).delete_many({"incident_id": incident_id}).deleted_count


def inject_reports(
    incident_id: str,
    events: Iterable[Mapping[str, Any]],
    now: datetime,
    *,
    until: datetime | None = None,
    received_at_for: Callable[[datetime], datetime] | None = None,
) -> dict[str, int]:
    """Write the phone and responder reports among ``events`` (drill upload time ``at`` <= ``until``)
    into ``live_reports`` as ``simulated``. ``received_at_for(drill_at)`` gives the wall receipt time
    (default ``now``). Returns counts: inserted, existing (same client_id: retries), rate_limited,
    invalid, skipped (not a phone or responder report, or after ``until``)."""
    from . import views  # local: views imports this package's modules

    gn = _gen_noise()
    index = get_index()
    reports = col("live_reports")
    counts = {"inserted": 0, "existing": 0, "rate_limited": 0, "invalid": 0, "skipped": 0}
    sent: dict[str, list[datetime]] = defaultdict(list)
    ordered = sorted(events, key=lambda e: (e.get("at") or "", gn.event_id(e)))
    for ev in ordered:
        src = gn.source_of(ev)
        if src not in ("resident", "responder") or not gn.is_report(ev) or not ev.get("at"):
            counts["skipped"] += 1
            continue
        at = gn.parse_utc(ev["at"])
        if until is not None and at > until:
            counts["skipped"] += 1
            continue
        body = dict(ev["body"])
        body.setdefault("observed_at", ev["at"])
        try:
            fields = views._validate_report(body, incident_id)
        except ApiError:
            counts["invalid"] += 1
            continue
        if reports.count_documents({"incident_id": incident_id, "client_id": fields["client_id"]}, limit=1):
            counts["existing"] += 1
            continue
        role = "responder" if src == "responder" else "civilian"
        party = ev.get("party_key") or f"sim_unit_{ev.get('unit')}"
        if role == "civilian":
            recent = sent[party]
            per_min = sum(1 for t in recent if (at - t).total_seconds() < 60)
            per_hour = sum(1 for t in recent if (at - t).total_seconds() < 3600)
            if per_min >= views.CIVILIAN_REPORTS_PER_MIN or per_hour >= views.CIVILIAN_REPORTS_PER_HOUR:
                counts["rate_limited"] += 1
                continue
            recent.append(at)
        road_ref = None
        if fields["kind"] in views.ROAD_KINDS:
            snapped = snap_to_segment(index, tuple(fields["location"]["coord"]))
            if snapped is not None:
                segment_id, snap_m = snapped
                road_ref = {"segment_id": segment_id, "name": index.segment_names.get(segment_id) or "Unnamed road",
                            "snap_m": round(snap_m, 1)}
        received = received_at_for(at) if received_at_for else now
        # Phones send wall-clock observed_at and public.py fades on wall time, so the event's drill-time
        # observation becomes the wall time at the same lag before receipt (a late upload stays older).
        observed = received - (at - fields["observed_at"]) if fields["observed_at"] <= at else received
        reports.insert_one({
            "id": new_id("rpt_"),
            "client_id": fields["client_id"],
            "incident_id": incident_id,
            "reporter": {"role": role, "party_key": party},
            "kind": fields["kind"],
            "severity": fields["severity"],
            "location": fields["location"],
            "heading_deg": fields["heading_deg"],
            "road_ref": road_ref,
            "destination_id": fields["destination_id"],
            "task_id": None,
            "observed_at": observed,
            "received_at": received,
            "note": fields["note"],
            "status": "unverified",
            "evidence_class": EVIDENCE_CLASS,
            "replay_at": at,
            "updated_at": received,
        })
        counts["inserted"] += 1
    if counts["inserted"]:
        views._refresh_corroboration(incident_id)
    return counts


def drill_wall_mapper(replay_start: datetime, started_at: datetime, speed: float) -> Callable[[datetime], datetime]:
    """Wall receipt time of a drill time under a running clock (speed > 0): the inverse of
    ``livecore.drill.replay_now``. With speed 0 every receipt maps to ``started_at``."""
    def f(drill_at: datetime) -> datetime:
        if speed <= 0:
            return started_at
        return started_at + timedelta(seconds=(drill_at - replay_start).total_seconds() / speed)

    return f
