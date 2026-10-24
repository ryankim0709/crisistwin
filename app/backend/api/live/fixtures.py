"""Drill fixture reports for demos (``live_drill --seed``). Synthetic, never real observations.

Three independent synthetic civilian parties report a full block on Skyway in Paradise, so
the block is public, guidance must avoid it and the controller sees a reroute. Every
document has ``evidence_class: "drill_fixture"`` and a note saying it is synthetic.
"""

from __future__ import annotations

import math
import uuid
from datetime import timedelta

from .common import col, new_id, wall_now
from .drillcache import DrillIndex
from .state import report_replay_at

FIXTURE_ROAD_NAMES = ("Skyway", "Skyway Road")
FIXTURE_NEAR = (-121.6219, 39.7596)
"""Paradise town center; the fixture block is the named segment nearest to it."""
FIXTURE_NOTE = "Drill fixture: synthetic report, not a real observation."
FIXTURE_PARTIES = ("fixture_civ_1", "fixture_civ_2", "fixture_civ_3")
FIXTURE_SPACING_MIN = 6
"""Minutes between fixture reports, more than SAME_PARTY_WINDOW_S so they count as independent."""


def fixture_segment(index: DrillIndex) -> str:
    best: tuple[float, str] | None = None
    for segment_id, name in index.segment_names.items():
        if name not in FIXTURE_ROAD_NAMES:
            continue
        line = index.segment_lines[segment_id]
        mid = line[len(line) // 2]
        d = math.hypot(mid[0] - FIXTURE_NEAR[0], mid[1] - FIXTURE_NEAR[1])
        if best is None or d < best[0]:
            best = (d, segment_id)
    if best is None:
        raise ValueError("No Skyway segment in the drill road network.")
    return best[1]


def seed_reports(index: DrillIndex, incident_id: str) -> list[str]:
    """Insert (idempotently, by client_id) the fixture reports; returns their ids."""
    segment_id = fixture_segment(index)
    line = index.segment_lines[segment_id]
    now = wall_now()
    reports = col("live_reports")
    ids = []
    for i, party in enumerate(FIXTURE_PARTIES):
        client_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"crisistwin:{incident_id}:drill-fixture:{i}"))
        existing = reports.find_one({"incident_id": incident_id, "client_id": client_id})
        if existing is not None:
            ids.append(existing["id"])
            continue
        coord = line[min(len(line) - 1, (len(line) // 2) + i - 1)] if len(line) > 2 else line[0]
        observed = now - timedelta(minutes=FIXTURE_SPACING_MIN * (len(FIXTURE_PARTIES) - i))
        doc = {
            "id": new_id("rpt_"),
            "client_id": client_id,
            "incident_id": incident_id,
            "reporter": {"role": "civilian", "party_key": party},
            "kind": "road_blocked",
            "severity": "full",
            "location": {"coord": [coord[0], coord[1]], "accuracy_m": 10.0},
            "heading_deg": None,
            "road_ref": {"segment_id": segment_id, "name": index.segment_names.get(segment_id) or "Skyway",
                         "snap_m": 0.0},
            "destination_id": None,
            "task_id": None,
            "observed_at": observed,
            "received_at": observed + timedelta(seconds=30),
            "note": FIXTURE_NOTE,
            "status": "unverified",
            "evidence_class": "drill_fixture",
            "replay_at": report_replay_at(incident_id, now),
            "updated_at": now,
        }
        reports.insert_one(doc)
        ids.append(doc["id"])
    return ids
