"""Public map items and road state from field reports (ADR 0011 rules, v1 contract).

Contract: docs/live-reports.md "Rules". Fading and staleness use wall time, since reports
are real-time observations even during a drill. All counting is deterministic; an LLM never
sets status or confidence.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from .drill import FireObservation
from .geo import LonLat, haversine_m

SAME_PARTY_WINDOW_S = 120
"""Reports within this many seconds and SAME_PARTY_RADIUS_M of each other are one party."""
SAME_PARTY_RADIUS_M = 100
PUBLIC_MIN_CIVILIAN_PARTIES = 3
CLUSTER_RADIUS_M = 200
"""Non-road reports of the same kind within this distance form one item."""
HALF_LIFE_S: Mapping[str, int] = {
    "fire_seen": 900,
    "heavy_smoke": 900,
    "heavy_traffic": 900,
    "road_blocked": 7200,
    "road_passable": 7200,
    "hazard_down": 14400,
    "shelter_full": 3600,
}
"""Confidence halves every HALF_LIFE_S[kind] seconds since the last corroboration."""
STALE_CONFIDENCE = 0.25
"""Items below this confidence are stale and leave the public map."""
NEVER_PUBLIC_KINDS = frozenset({"help_needed"})
ROAD_KINDS = frozenset({"road_blocked", "road_passable", "heavy_traffic"})
"""Kinds that snap to a road segment and group by it."""
DEFAULT_HALF_LIFE_S = 3600
"""Half-life for a kind missing from HALF_LIFE_S."""
CONTRADICTS: Mapping[str, str] = {"road_blocked": "road_passable", "road_passable": "road_blocked"}

Role = Literal["civilian", "responder", "controller"]
ReportStatusValue = Literal["unverified", "corroborated", "responder_confirmed", "confirmed", "dismissed", "resolved"]
RoadStatusValue = Literal["open", "slow", "blocked", "unknown"]


@dataclass(frozen=True)
class ReportFact:
    """The fields of a stored report that the rules need."""

    id: str
    kind: str
    severity: Literal["full", "partial", "slow"] | None
    coord: LonLat
    party_key: str
    role: Role
    observed_at: datetime
    received_at: datetime
    status: ReportStatusValue
    """``confirmed`` means a controller confirmed it."""
    segment_id: str | None
    segment_name: str | None
    destination_id: str | None
    replay_at: datetime | None
    """Drill time at receipt; None when no drill ran."""


@dataclass(frozen=True)
class PublicItem:
    """One public-map / prompts item (v1 shape)."""

    id: str
    """``pub_<segment_id or cluster key>_<kind>``."""
    kind: str
    severity: str | None
    coord: LonLat
    segment_id: str | None
    segment_name: str | None
    line: tuple[LonLat, ...] | None
    independent_parties: int
    responder_reports: int
    controller_confirmed: bool
    confidence: float
    first_reported_at: datetime
    last_observed_at: datetime
    report_ids: tuple[str, ...]
    destination_id: str | None


@dataclass(frozen=True)
class RoadStatus:
    """One ``road-state`` item (v1 shape)."""

    segment_id: str
    name: str | None
    status: RoadStatusValue
    confidence: float
    independent_parties: int
    responder_reports: int
    last_observed_at: datetime
    report_ids: tuple[str, ...]
    decided_by: str | None
    """``controller`` when a triage decision set it, else None."""
    public: bool


def same_party(a: ReportFact, b: ReportFact) -> bool:
    """Same ``party_key``, or within SAME_PARTY_WINDOW_S and SAME_PARTY_RADIUS_M (observed_at)."""
    if a.party_key == b.party_key:
        return True
    return (abs((a.observed_at - b.observed_at).total_seconds()) <= SAME_PARTY_WINDOW_S
            and haversine_m(a.coord, b.coord) <= SAME_PARTY_RADIUS_M)


def _live(reports: Sequence[ReportFact]) -> list[ReportFact]:
    return [r for r in reports if r.status not in ("dismissed", "resolved")]


def _is_responder(r: ReportFact) -> bool:
    return r.role in ("responder", "controller")


def independent_counts(reports: Sequence[ReportFact]) -> tuple[int, int]:
    """``(independent civilian parties, responder reports)`` among the non-dismissed reports.

    Civilian reports are grouped into parties with ``same_party`` (transitively). A civilian
    party that is the same party as a responder report is not independent and is not counted.
    """
    live = [r for r in reports if r.status != "dismissed"]
    responders = [r for r in live if _is_responder(r)]
    civilians = sorted((r for r in live if not _is_responder(r)), key=lambda r: (r.observed_at, r.id))
    parent = list(range(len(civilians)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(civilians)):
        for j in range(i + 1, len(civilians)):
            if same_party(civilians[i], civilians[j]):
                parent[find(i)] = find(j)
    tainted = {find(i) for i, c in enumerate(civilians) if any(same_party(c, r) for r in responders)}
    parties = {find(i) for i in range(len(civilians))} - tainted
    return len(parties), len(responders)


def confidence(kind: str, last_corroborated_at: datetime, wall_now: datetime, base: float = 1.0) -> float:
    """``base * 0.5 ** (age_s / HALF_LIFE_S[kind])``; 0..1."""
    age_s = max((wall_now - last_corroborated_at).total_seconds(), 0.0)
    half = HALF_LIFE_S.get(kind, DEFAULT_HALF_LIFE_S)
    return min(max(base * 0.5 ** (age_s / half), 0.0), 1.0)


def is_public(kind: str, civilian_parties: int, responder_reports: int, controller_confirmed: bool,
              confidence_value: float, contradicted: bool) -> bool:
    """v1 rule: not stale, not contradicted, kind can be public, and one of: >= 3 civilian
    parties; >= 1 responder and >= 1 independent civilian party; controller confirmation."""
    if kind in NEVER_PUBLIC_KINDS or contradicted or confidence_value < STALE_CONFIDENCE:
        return False
    return (civilian_parties >= PUBLIC_MIN_CIVILIAN_PARTIES
            or (responder_reports >= 1 and civilian_parties >= 1)
            or controller_confirmed)


def cluster(reports: Sequence[ReportFact]) -> list[list[ReportFact]]:
    """Group by (segment_id, kind) for road kinds, destination for ``shelter_full``, and
    CLUSTER_RADIUS_M for the rest. Dismissed and resolved reports are dropped."""
    keyed: dict[tuple[str, str, str], list[ReportFact]] = {}
    loose: list[ReportFact] = []
    for r in sorted(_live(reports), key=lambda r: (r.observed_at, r.id)):
        if r.kind in ROAD_KINDS and r.segment_id:
            keyed.setdefault(("seg", r.segment_id, r.kind), []).append(r)
        elif r.kind == "shelter_full" and r.destination_id:
            keyed.setdefault(("dst", r.destination_id, r.kind), []).append(r)
        else:
            loose.append(r)
    groups = list(keyed.values())
    seeds: list[list[ReportFact]] = []
    for r in loose:  # greedy: join the first same-kind cluster whose seed is within range
        for g in seeds:
            if g[0].kind == r.kind and haversine_m(g[0].coord, r.coord) <= CLUSTER_RADIUS_M:
                g.append(r)
                break
        else:
            seeds.append([r])
    groups.extend(seeds)
    groups.sort(key=lambda g: (g[0].observed_at, g[0].id))
    return groups


def _contradicted(group: Sequence[ReportFact], live: Sequence[ReportFact]) -> bool:
    """A newer contradicting report on the same segment from a party independent of the group."""
    kind = group[0].kind
    other = CONTRADICTS.get(kind)
    seg = group[0].segment_id
    if other is None or seg is None:
        return False
    last = max(r.observed_at for r in group)
    return any(
        c.kind == other and c.segment_id == seg and c.observed_at > last
        and not any(same_party(c, r) for r in group)
        for c in live
    )


def _mean_coord(group: Sequence[ReportFact]) -> LonLat:
    return (sum(r.coord[0] for r in group) / len(group), sum(r.coord[1] for r in group) / len(group))


def public_items(
    reports: Sequence[ReportFact],
    wall_now: datetime,
    segment_lines: Mapping[str, Sequence[LonLat]],
) -> list[PublicItem]:
    """Items that pass ``is_public``. ``segment_lines`` maps segment id -> polyline for ``line``."""
    live = _live(reports)
    out: list[PublicItem] = []
    for group in cluster(reports):
        head = group[0]
        kind = head.kind
        civ, resp = independent_counts(group)
        confirmed = any(r.status == "confirmed" for r in group)
        last = max(r.observed_at for r in group)
        conf = confidence(kind, last, wall_now)
        if not is_public(kind, civ, resp, confirmed, conf, _contradicted(group, live)):
            continue
        latest = max(group, key=lambda r: (r.observed_at, r.id))
        if kind in ROAD_KINDS and head.segment_id:
            key = head.segment_id
        elif kind == "shelter_full" and head.destination_id:
            key = head.destination_id
        else:
            key = head.id
        line = segment_lines.get(head.segment_id) if head.segment_id else None
        out.append(PublicItem(
            id=f"pub_{key}_{kind}",
            kind=kind,
            severity=latest.severity,
            coord=_mean_coord(group),
            segment_id=head.segment_id if kind in ROAD_KINDS else None,
            segment_name=next((r.segment_name for r in group if r.segment_name), None),
            line=tuple(tuple(p) for p in line) if line else None,  # type: ignore[misc]
            independent_parties=civ,
            responder_reports=resp,
            controller_confirmed=confirmed,
            confidence=round(conf, 4),
            first_reported_at=min(r.observed_at for r in group),
            last_observed_at=last,
            report_ids=tuple(r.id for r in group),
            destination_id=head.destination_id if kind == "shelter_full" else None,
        ))
    return out


def road_state(reports: Sequence[ReportFact], wall_now: datetime) -> list[RoadStatus]:
    """Per-segment status from road kinds (blocked/partial -> blocked, slow/heavy_traffic -> slow,
    newer independent road_passable -> open); ``public`` mirrors ``is_public``.

    A controller-confirmed block stays blocked until a ``road_passable`` report is itself
    controller confirmed; otherwise a newer independent ``road_passable`` opens the road.
    """
    by_segment: dict[str, list[ReportFact]] = {}
    for r in _live(reports):
        if r.kind in ROAD_KINDS and r.segment_id:
            by_segment.setdefault(r.segment_id, []).append(r)
    out: list[RoadStatus] = []
    for seg in sorted(by_segment):
        group = by_segment[seg]
        blocked = [r for r in group if r.kind == "road_blocked" and r.severity != "slow"]
        slow = [r for r in group if r.kind == "heavy_traffic" or (r.kind == "road_blocked" and r.severity == "slow")]
        passable = [r for r in group if r.kind == "road_passable"]

        def newest(rs: list[ReportFact]) -> datetime:
            return max(r.observed_at for r in rs)

        def confirmed(rs: list[ReportFact]) -> bool:
            return any(r.status == "confirmed" for r in rs)

        status: RoadStatusValue
        chosen: list[ReportFact]
        kind: str
        opens = bool(passable) and (
            not blocked
            or confirmed(passable)
            or (not confirmed(blocked) and newest(passable) > newest(blocked)
                and not any(same_party(p, b) for p in passable for b in blocked))
        )
        if blocked and not opens:
            status, chosen, kind = "blocked", blocked, "road_blocked"
        elif opens and not (slow and newest(slow) > newest(passable)):
            status, chosen, kind = "open", passable, "road_passable"
        elif slow:
            status, chosen, kind = "slow", slow, "heavy_traffic"
        else:
            status, chosen, kind = "unknown", group, group[0].kind
        civ, resp = independent_counts(chosen)
        is_confirmed = confirmed(chosen)
        last = newest(chosen)
        conf = confidence(kind, last, wall_now)
        out.append(RoadStatus(
            segment_id=seg,
            name=next((r.segment_name for r in group if r.segment_name), None),
            status=status,
            confidence=round(conf, 4),
            independent_parties=civ,
            responder_reports=resp,
            last_observed_at=last,
            report_ids=tuple(r.id for r in sorted(chosen, key=lambda r: (r.observed_at, r.id))),
            decided_by="controller" if is_confirmed else None,
            public=is_public(kind, civ, resp, is_confirmed, conf, False),
        ))
    return out


def guidance_blocked_segments(state: Sequence[RoadStatus]) -> frozenset[str]:
    """Segments guidance must avoid: ``status == "blocked"`` and ``public`` (v2 rule)."""
    return frozenset(s.segment_id for s in state if s.status == "blocked" and s.public)


def controller_blocked_segments(state: Sequence[RoadStatus]) -> frozenset[str]:
    """Segments the impact simulation closes: blocked and ``decided_by == "controller"`` (v1 rule)."""
    return frozenset(s.segment_id for s in state if s.status == "blocked" and s.decided_by == "controller")


def full_destination_ids(items: Sequence[PublicItem]) -> frozenset[str]:
    """Destinations with a public ``shelter_full`` item."""
    return frozenset(i.destination_id for i in items if i.kind == "shelter_full" and i.destination_id)


def confirmed_fire_points(reports: Sequence[ReportFact], items: Sequence[PublicItem]) -> list[FireObservation]:
    """``fire_seen`` reports that are controller confirmed or part of a public item and have a
    ``replay_at``, as ``FireObservation(source="field_report", at=replay_at)``."""
    public_ids = {rid for i in items if i.kind == "fire_seen" for rid in i.report_ids}
    out = [
        FireObservation(id=r.id, at=r.replay_at, coord=r.coord, source="field_report")
        for r in reports
        if r.kind == "fire_seen" and r.replay_at is not None
        and r.status not in ("dismissed", "resolved")
        and (r.status == "confirmed" or r.id in public_ids)
    ]
    out.sort(key=lambda o: (o.at, o.id))
    return out
