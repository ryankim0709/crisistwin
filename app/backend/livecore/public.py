"""Public map items and road state from field reports (ADR 0011 rules, v1 contract).

Contract: docs/live-reports.md "Rules". Fading and staleness use wall time, since reports
are real-time observations even during a drill. All counting is deterministic; an LLM never
sets status or confidence.

Client clocks are not trusted: party independence compares server ``received_at``, and every
ordering or age uses ``effective_at(r) = min(observed_at, received_at)``, so a backdated report
cannot pose as a separate party and a future-dated one can never sort as newest.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from .drill import FireObservation
from .geo import LonLat, haversine_m

SAME_PARTY_WINDOW_S = 120
"""Reports received (server time) within this many seconds and SAME_PARTY_RADIUS_M of each other are one party."""
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
PASSIVE_PARTY_WEIGHT = 0.5
"""ADR 0041: a civilian party whose reports in a group are all ``method: "passive"`` (a phone that
drove through a segment, opt-in) counts this fraction of an explicit party. ASSUMPTION to calibrate
in drills. Passive-only evidence never overrides a block or another contradicting state."""

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
    method: Literal["explicit", "passive"] = "explicit"
    """``passive``: an automatic traversal observation (ADR 0041); weaker evidence."""


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
    passive_parties: int = 0
    """Civilian parties (in ``independent_parties``) whose reports here are all passive."""


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
    passive_parties: int = 0
    """Civilian parties (in ``independent_parties``) whose reports here are all passive."""


def effective_at(r: ReportFact) -> datetime:
    """``min(observed_at, received_at)``: the time used for ordering and age."""
    return min(r.observed_at, r.received_at)


def _order(r: ReportFact) -> tuple[datetime, str]:
    return (effective_at(r), r.id)


def same_party(a: ReportFact, b: ReportFact) -> bool:
    """Same ``party_key``, or received within SAME_PARTY_WINDOW_S and SAME_PARTY_RADIUS_M."""
    if a.party_key == b.party_key:
        return True
    return (abs((a.received_at - b.received_at).total_seconds()) <= SAME_PARTY_WINDOW_S
            and haversine_m(a.coord, b.coord) <= SAME_PARTY_RADIUS_M)


def _live(reports: Sequence[ReportFact]) -> list[ReportFact]:
    return [r for r in reports if r.status not in ("dismissed", "resolved")]


def _is_responder(r: ReportFact) -> bool:
    return r.role in ("responder", "controller")


def independent_counts(reports: Sequence[ReportFact]) -> tuple[int, int]:
    """``(independent civilian parties, responder reports)`` among the non-dismissed reports.

    Each civilian ``party_key`` is one candidate, represented by its first report (server
    ``received_at``). Keys are taken in that order; a key is tainted (not counted) when its
    first report is ``same_party`` with any responder report; otherwise it folds into the first
    counted anchor whose first report is directly ``same_party`` with its own, or becomes a new
    counted anchor. Not transitive: a steady crowd arriving over time is not chained into one.
    """
    live = [r for r in reports if r.status != "dismissed"]
    responders = [r for r in live if _is_responder(r)]
    firsts: dict[str, ReportFact] = {}
    for r in live:
        if _is_responder(r):
            continue
        have = firsts.get(r.party_key)
        if have is None or (r.received_at, r.id) < (have.received_at, have.id):
            firsts[r.party_key] = r
    anchors: list[ReportFact] = []
    for first in sorted(firsts.values(), key=lambda r: (r.received_at, r.id)):
        if any(same_party(first, r) for r in responders):
            continue
        if not any(same_party(a, first) for a in anchors):
            anchors.append(first)
    return len(anchors), len(responders)


def is_passive(r: ReportFact) -> bool:
    return r.method == "passive"


def party_counts(reports: Sequence[ReportFact]) -> tuple[float, int, int, int]:
    """``(weighted civilian parties, explicit responder reports, civilian parties, passive-only parties)``.

    Explicit parties count 1 and parties seen only through passive reports count
    PASSIVE_PARTY_WEIGHT; ``civilian parties`` is the unweighted ``independent_counts`` over all
    reports and ``passive-only`` the parties it adds over the explicit reports alone. A responder's
    passive report is not a responder report (it counts for nothing toward publicity).
    """
    explicit = [r for r in reports if not is_passive(r)]
    civ_all, _ = independent_counts(reports)
    civ_explicit, resp = independent_counts(explicit)
    passive_only = max(0, civ_all - civ_explicit)
    return civ_explicit + PASSIVE_PARTY_WEIGHT * passive_only, resp, civ_all, passive_only


def confidence(kind: str, last_corroborated_at: datetime, wall_now: datetime, base: float = 1.0) -> float:
    """``base * 0.5 ** (age_s / HALF_LIFE_S[kind])``; 0..1."""
    age_s = max((wall_now - last_corroborated_at).total_seconds(), 0.0)
    half = HALF_LIFE_S.get(kind, DEFAULT_HALF_LIFE_S)
    return min(max(base * 0.5 ** (age_s / half), 0.0), 1.0)


def is_public(kind: str, civilian_parties: float, responder_reports: int, controller_confirmed: bool,
              confidence_value: float, contradicted: bool) -> bool:
    """v1 rule: not stale, not contradicted, kind can be public, and one of: >= 3 civilian
    parties; >= 1 responder and >= 1 independent civilian party; controller confirmation.
    ``civilian_parties`` is weighted (``party_counts``): passive-only parties count less."""
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
    for r in sorted(_live(reports), key=_order):
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
    groups.sort(key=lambda g: _order(g[0]))
    return groups


def _newest(rs: Sequence[ReportFact]) -> datetime:
    return max(effective_at(r) for r in rs)


def _confirmed(rs: Sequence[ReportFact]) -> bool:
    return any(r.status == "confirmed" for r in rs)


def _overrides(newer: Sequence[ReportFact], older: Sequence[ReportFact]) -> bool:
    """Whether contradicting reports ``newer`` override ``older`` on one segment.

    Yes when ``newer`` is controller confirmed. Otherwise only if ``older`` is not confirmed,
    ``newer`` is more recent (effective time), has at least one explicit (not passive) report, no
    report pair is directly ``same_party``, and ``newer`` is at least as strong: as many weighted
    independent civilian parties (``party_counts``), or a responder report where ``older`` has none.
    """
    if not newer:
        return False
    if not older or _confirmed(newer):
        return True
    if _confirmed(older) or _newest(newer) <= _newest(older):
        return False
    if all(is_passive(n) for n in newer):
        return False
    if any(same_party(n, o) for n in newer for o in older):
        return False
    n_civ, n_resp, _, _ = party_counts(newer)
    o_civ, o_resp, _, _ = party_counts(older)
    return n_civ >= o_civ or (n_resp > 0 and o_resp == 0)


def _contradicted(group: Sequence[ReportFact], live: Sequence[ReportFact]) -> bool:
    """Contradicting reports on the same segment that override the group (``_overrides``)."""
    other = CONTRADICTS.get(group[0].kind)
    seg = group[0].segment_id
    if other is None or seg is None:
        return False
    return _overrides([c for c in live if c.kind == other and c.segment_id == seg], group)


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
        weighted, resp, civ, passive = party_counts(group)
        confirmed = _confirmed(group)
        last = _newest(group)
        conf = confidence(kind, last, wall_now)
        if not is_public(kind, weighted, resp, confirmed, conf, _contradicted(group, live)):
            continue
        latest = max(group, key=_order)
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
            first_reported_at=min(effective_at(r) for r in group),
            last_observed_at=last,
            report_ids=tuple(r.id for r in group),
            destination_id=head.destination_id if kind == "shelter_full" else None,
            passive_parties=passive,
        ))
    return out


def road_state(reports: Sequence[ReportFact], wall_now: datetime) -> list[RoadStatus]:
    """Per-segment status from road kinds (blocked/partial -> blocked, slow/heavy_traffic -> slow,
    road_passable that overrides the block -> open); ``public`` mirrors ``is_public``.

    ``road_passable`` opens a blocked segment only per ``_overrides``: it is controller
    confirmed, or the block is unconfirmed and the passable reports are newer (effective time),
    from parties distinct from the blockers, and at least as strong as the block.
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

        status: RoadStatusValue
        chosen: list[ReportFact]
        kind: str
        opens = _overrides(passable, blocked)
        if blocked and not opens:
            status, chosen, kind = "blocked", blocked, "road_blocked"
        elif opens and not (slow and _newest(slow) > _newest(passable)):
            status, chosen, kind = "open", passable, "road_passable"
        elif slow:
            status, chosen, kind = "slow", slow, "heavy_traffic"
        else:
            status, chosen, kind = "unknown", group, group[0].kind
        weighted, resp, civ, passive = party_counts(chosen)
        is_confirmed = _confirmed(chosen)
        last = _newest(chosen)
        conf = confidence(kind, last, wall_now)
        out.append(RoadStatus(
            segment_id=seg,
            name=next((r.segment_name for r in group if r.segment_name), None),
            status=status,
            confidence=round(conf, 4),
            independent_parties=civ,
            responder_reports=resp,
            last_observed_at=last,
            report_ids=tuple(r.id for r in sorted(chosen, key=_order)),
            decided_by="controller" if is_confirmed else None,
            public=is_public(kind, weighted, resp, is_confirmed, conf, False),
            passive_parties=passive,
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
